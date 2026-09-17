import { describe, expect, it } from "bun:test"
import { useTempDir } from "../src/utils/test-utils.ts"
import { applyMutationOverlay, buildCountSummary } from "./posttooluse-task-count-context.ts"

const tmp = useTempDir("swiz-task-count-context-")

describe("applyMutationOverlay", () => {
  it("updates task status on TaskUpdate", () => {
    const tasks = [
      { id: "1", status: "in_progress" },
      { id: "2", status: "pending" },
    ]
    const result = applyMutationOverlay(tasks, "TaskUpdate", {
      taskId: "1",
      status: "completed",
    })
    expect(result.find((t) => t.id === "1")?.status).toBe("completed")
    expect(result.find((t) => t.id === "2")?.status).toBe("pending")
  })

  it("updates task status on TodoWrite", () => {
    const tasks = [{ id: "1", status: "pending" }]
    const result = applyMutationOverlay(tasks, "TodoWrite", {
      id: "1",
      status: "in_progress",
    })
    expect(result[0]?.status).toBe("in_progress")
  })

  it("adds pending placeholder on TaskCreate when no pending exists", () => {
    const tasks = [{ id: "1", status: "completed" }]
    const result = applyMutationOverlay(tasks, "TaskCreate", {
      subject: "New task",
    })
    expect(result).toHaveLength(2)
    expect(result[1]?.status).toBe("pending")
  })

  it("does not add placeholder on TaskCreate when pending already exists", () => {
    const tasks = [
      { id: "1", status: "completed" },
      { id: "2", status: "pending" },
    ]
    const result = applyMutationOverlay(tasks, "TaskCreate", {
      subject: "New task",
    })
    expect(result).toHaveLength(2)
  })

  it("no-ops when TaskUpdate has no matching task ID", () => {
    const tasks = [{ id: "1", status: "pending" }]
    const result = applyMutationOverlay(tasks, "TaskUpdate", {
      taskId: "999",
      status: "completed",
    })
    expect(result[0]?.status).toBe("pending")
  })

  it("no-ops for unknown tool names", () => {
    const tasks = [{ id: "1", status: "pending" }]
    const result = applyMutationOverlay(tasks, "TaskList", {})
    expect(result).toHaveLength(1)
    expect(result[0]?.status).toBe("pending")
  })
})

describe("buildCountSummary", () => {
  for (const counts of [
    { total: 0, incomplete: 0, pending: 0, inProgress: 0 },
    { total: 4, incomplete: 0, pending: 0, inProgress: 0 },
    { total: 1, incomplete: 1, pending: 0, inProgress: 1 },
    { total: 2, incomplete: 2, pending: 1, inProgress: 1 },
    { total: 3, incomplete: 3, pending: 3, inProgress: 0 },
    { total: 4, incomplete: 3, pending: 2, inProgress: 1 },
  ]) {
    it(`reports factual counts for ${JSON.stringify(counts)}`, () => {
      expect(buildCountSummary(counts)).toBe(
        `Tasks: ${counts.inProgress} in_progress, ${counts.pending} pending, ${counts.incomplete} incomplete (${counts.total} total).`
      )
    })
  }

  it("preserves optional issue hints without describing queue depth as divergence", () => {
    const counts = { total: 2, incomplete: 2, pending: 1, inProgress: 1 }
    expect(buildCountSummary({ ...counts, issueHints: ["#42 Fix auth timeout"] })).toContain(
      "Potential follow-up issues"
    )
    expect(buildCountSummary({ ...counts, issueHints: [] })).toBe(buildCountSummary(counts))
    expect(
      buildCountSummary({ ...counts, pending: 2, issueHints: ["#42 Fix auth timeout"] })
    ).not.toContain("Potential follow-up issues")
  })
})

describe("evaluatePosttooluseTaskCountContext", () => {
  it("suppresses output on TaskUpdate when task governance is healthy", async () => {
    const { applyTaskListEvent } = await import("../src/tasks/task-event-state.ts")
    const { evaluatePosttooluseTaskCountContext } = await import(
      "./posttooluse-task-count-context.ts"
    )
    const sessionId = "test-session-healthy-taskupdate"
    applyTaskListEvent(sessionId, [
      { id: "1", status: "in_progress", subject: "A" },
      { id: "2", status: "pending", subject: "B" },
      { id: "3", status: "pending", subject: "C" },
    ])
    const res = await evaluatePosttooluseTaskCountContext({
      session_id: sessionId,
      tool_name: "TaskUpdate",
      tool_input: { taskId: "1", status: "in_progress" },
      cwd: await tmp.create(),
      agent: "claude",
    })
    expect(res).toEqual({})
  })

  it("does not suppress output on TaskUpdate when task governance is unhealthy", async () => {
    const { applyTaskListEvent } = await import("../src/tasks/task-event-state.ts")
    const { evaluatePosttooluseTaskCountContext } = await import(
      "./posttooluse-task-count-context.ts"
    )
    const sessionId = "test-session-unhealthy-taskupdate"
    applyTaskListEvent(sessionId, [{ id: "1", status: "in_progress", subject: "A" }])
    const res = await evaluatePosttooluseTaskCountContext({
      session_id: sessionId,
      tool_name: "TaskUpdate",
      tool_input: { taskId: "1", status: "in_progress" },
      cwd: await tmp.create(),
      agent: "claude",
    })
    expect(res).not.toEqual({})
    expect((res as any).systemMessage).toContain(
      "Tasks: 1 in_progress, 0 pending, 1 incomplete (1 total)."
    )
  })
})
