import { describe, expect, test } from "bun:test"
import { toSessionTaskPreview } from "../../commands/daemon/utils.ts"
import type { ProjectTask, SessionTask } from "./session-browser-types.ts"
import { groupTasksByStore } from "./session-tasks.tsx"
import { detailBeyondSubject, queueHintFor } from "./task-board.tsx"

function webTask(
  overrides: Partial<SessionTask> & Pick<SessionTask, "id" | "status">
): SessionTask {
  return {
    subject: `subject ${overrides.id}`,
    description: null,
    statusChangedAt: null,
    completionTimestamp: null,
    completionEvidence: null,
    blockedBy: [],
    blocks: [],
    startedAt: null,
    elapsedMs: null,
    ...overrides,
  }
}

function projectTask(
  sessionId: string,
  overrides: Partial<SessionTask> & Pick<SessionTask, "id" | "status">
): ProjectTask {
  return { sessionId, ...webTask(overrides) }
}

describe("toSessionTaskPreview", () => {
  test("carries the dependency edges and timing the board needs", () => {
    const preview = toSessionTaskPreview({
      id: "a1",
      subject: "Ship it",
      description: "why",
      status: "in_progress",
      blockedBy: ["a0"],
      blocks: ["a2"],
      startedAt: 1000,
      elapsedMs: 250,
    })
    expect(preview.blockedBy).toEqual(["a0"])
    expect(preview.blocks).toEqual(["a2"])
    expect(preview.startedAt).toBe(1000)
    expect(preview.elapsedMs).toBe(250)
    expect(preview.description).toBe("why")
  })

  test("absent edges become empty arrays, not undefined", () => {
    const preview = toSessionTaskPreview({ id: "a1", subject: "s", status: "pending" })
    expect(preview.blockedBy).toEqual([])
    expect(preview.blocks).toEqual([])
    expect(preview.description).toBeNull()
    expect(preview.elapsedMs).toBeNull()
  })

  test("copies the edge arrays so the payload cannot alias the stored record", () => {
    const stored = { id: "a1", subject: "s", status: "pending", blockedBy: ["x"], blocks: [] }
    const preview = toSessionTaskPreview(stored)
    preview.blockedBy.push("y")
    expect(stored.blockedBy).toEqual(["x"])
  })
})

describe("groupTasksByStore", () => {
  const cwd = "/Users/me/Development/swiz"
  const projectKey = "-Users-me-Development-swiz"

  test("labels the project-keyed store distinctly from a session store", () => {
    const groups = groupTasksByStore(
      [
        projectTask("6a42743e-f46d-462a-a0ad-5c902f71cc53", { id: "s1", status: "completed" }),
        projectTask(projectKey, { id: "p1", status: "completed" }),
      ],
      cwd
    )
    const projectGroup = groups.find((group) => group.isProjectStore)
    expect(projectGroup?.label).toBe("Project store (MCP tasks)")
    expect(groups.filter((group) => group.isProjectStore)).toHaveLength(1)
    expect(groups.find((group) => !group.isProjectStore)?.label).toBe("6a42743e…cc53")
  })

  test("orders stores with open work first", () => {
    const groups = groupTasksByStore(
      [
        projectTask("quiet-session-id-aaaa", { id: "q1", status: "completed" }),
        projectTask("busy-session-id-bbbb", { id: "b1", status: "in_progress" }),
      ],
      cwd
    )
    expect(groups.map((group) => group.storeKey)).toEqual([
      "busy-session-id-bbbb",
      "quiet-session-id-aaaa",
    ])
    expect(groups[0]?.openCount).toBe(1)
  })

  test("keeps every task — grouping must not drop rows", () => {
    const tasks = [
      projectTask("s-one", { id: "1", status: "pending" }),
      projectTask("s-one", { id: "2", status: "completed" }),
      projectTask("s-two", { id: "3", status: "cancelled" }),
    ]
    const groups = groupTasksByStore(tasks, cwd)
    expect(groups.flatMap((group) => group.tasks)).toHaveLength(tasks.length)
  })

  test("without a cwd no store is claimed as the project store", () => {
    const groups = groupTasksByStore(
      [projectTask(projectKey, { id: "p1", status: "pending" })],
      null
    )
    expect(groups[0]?.isProjectStore).toBe(false)
  })
})

describe("detailBeyondSubject", () => {
  test("drops a description that merely repeats the subject", () => {
    const task = webTask({ id: "a", status: "pending", description: "  subject a  " })
    expect(task.subject).toBe("subject a")
    expect(detailBeyondSubject(task)).toBeNull()
  })

  test("keeps a description that adds something — the control for the case above", () => {
    const task = webTask({ id: "a", status: "pending", description: "why it matters" })
    expect(detailBeyondSubject(task)).toBe("why it matters")
  })

  test("evidence wins over description", () => {
    const task = webTask({
      id: "a",
      status: "completed",
      description: "planned",
      completionEvidence: "commit:abc123",
    })
    expect(detailBeyondSubject(task)).toBe("commit:abc123")
  })

  test("nothing to show when both are absent", () => {
    expect(detailBeyondSubject(webTask({ id: "a", status: "pending" }))).toBeNull()
  })
})

describe("queueHintFor", () => {
  test("names the critical-path task when nothing is running", () => {
    const tasks = [
      webTask({ id: "low", status: "pending" }),
      webTask({ id: "high", status: "pending" }),
      webTask({ id: "x", status: "pending", blockedBy: ["high"] }),
    ]
    expect(queueHintFor(tasks)).toContain("#high")
  })

  test("reports a deadlock rather than an all-blocked queue", () => {
    const hint = queueHintFor([
      webTask({ id: "a", status: "pending", blockedBy: ["b"] }),
      webTask({ id: "b", status: "pending", blockedBy: ["a"] }),
    ])
    expect(hint).toContain("Dependency cycle")
  })

  test("points at the in-progress task when every waiting task is blocked", () => {
    const hint = queueHintFor([
      webTask({ id: "run", status: "in_progress" }),
      webTask({ id: "wait", status: "pending", blockedBy: ["run"] }),
    ])
    expect(hint).toContain("#run")
  })

  test("stays silent when the queue is simply moving", () => {
    const hint = queueHintFor([
      webTask({ id: "run", status: "in_progress" }),
      webTask({ id: "next", status: "pending" }),
    ])
    expect(hint).toBeNull()
  })

  test("says so when there is no open work", () => {
    expect(queueHintFor([webTask({ id: "done", status: "completed" })])).toBe(
      "No open tasks in this queue."
    )
  })
})
