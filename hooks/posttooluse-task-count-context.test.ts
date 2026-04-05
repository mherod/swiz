import { describe, expect, it } from "bun:test"
import { applyMutationOverlay, buildCountSummary } from "./posttooluse-task-count-context.ts"

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
  it("praises healthy state when several pending and in_progress exist", () => {
    const s = buildCountSummary({
      total: 4,
      incomplete: 3,
      pending: 2,
      inProgress: 1,
    })
    expect(s).toContain("Good task hygiene")
    expect(s).toContain("planning buffer")
  })

  it("does not praise when no in_progress despite pending buffer", () => {
    const s = buildCountSummary({
      total: 3,
      incomplete: 3,
      pending: 3,
      inProgress: 0,
    })
    expect(s).not.toContain("Good task hygiene")
    expect(s).toContain("No in_progress task")
  })

  it("does not praise when only one pending even with in_progress", () => {
    const s = buildCountSummary({
      total: 2,
      incomplete: 2,
      pending: 1,
      inProgress: 1,
    })
    expect(s).not.toContain("Good task hygiene")
    expect(s).toContain("Proactive task planning needed")
  })

  it("still shows urgent zero-pending message without praise", () => {
    const s = buildCountSummary({
      total: 1,
      incomplete: 1,
      pending: 0,
      inProgress: 1,
    })
    expect(s).toContain("URGENT")
    expect(s).toContain("verification task")
    expect(s).toContain("broader next-step task")
    expect(s).not.toContain("Good task hygiene")
  })

  it("encourages specific task types when only 1 pending", () => {
    const s = buildCountSummary({
      total: 2,
      incomplete: 2,
      pending: 1,
      inProgress: 1,
    })
    expect(s).toContain("immediate verification step")
    expect(s).toContain("broader logical next task")
  })

  it("appends issue hints when pending is low and hints provided", () => {
    const s = buildCountSummary({
      total: 2,
      incomplete: 2,
      pending: 1,
      inProgress: 1,
      issueHints: ["#42 Fix auth timeout", "#57 Add retry logic"],
    })
    expect(s).toContain("Open issues you could plan for")
    expect(s).toContain("#42 Fix auth timeout")
    expect(s).toContain("#57 Add retry logic")
  })

  it("does not append issue hints when pending buffer is healthy", () => {
    const s = buildCountSummary({
      total: 4,
      incomplete: 3,
      pending: 2,
      inProgress: 1,
      issueHints: ["#42 Fix auth timeout"],
    })
    expect(s).not.toContain("Open issues you could plan for")
  })

  it("does not append issue hints when hints array is empty", () => {
    const s = buildCountSummary({
      total: 1,
      incomplete: 1,
      pending: 0,
      inProgress: 1,
      issueHints: [],
    })
    expect(s).not.toContain("Open issues you could plan for")
    expect(s).toContain("URGENT")
  })

  it("appends issue hints on urgent zero-pending state", () => {
    const s = buildCountSummary({
      total: 1,
      incomplete: 1,
      pending: 0,
      inProgress: 1,
      issueHints: ["#100 Critical bug in login"],
    })
    expect(s).toContain("URGENT")
    expect(s).toContain("Open issues you could plan for")
    expect(s).toContain("#100 Critical bug in login")
  })
})
