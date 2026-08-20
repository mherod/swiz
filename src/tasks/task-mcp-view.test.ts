import { describe, expect, it } from "bun:test"
import {
  countTasksFreedBy,
  findDependencyCycle,
  findNewlyUnblockedTasks,
  formatTaskLine,
  MAX_LISTED_PER_GROUP,
  MAX_SUBJECT_LENGTH,
  renderTaskBoard,
  renderTaskToolResult,
  renderUnblockedLine,
  STALE_IN_PROGRESS_MS,
  taskQueueHint,
  truncateForLine,
} from "./task-mcp-view.ts"
import type { Task } from "./task-repository.ts"

function task(id: string, status: Task["status"], overrides: Partial<Task> = {}): Task {
  return {
    id,
    subject: `Task ${id}`,
    description: "",
    status,
    blocks: [],
    blockedBy: [],
    ...overrides,
  }
}

const blocked = (id: string, blockers: string[]): Task =>
  task(id, "pending", { blockedBy: blockers })

describe("truncateForLine", () => {
  it("flattens whitespace so one task stays on one line", () => {
    expect(truncateForLine("  fix\n  the   bug ")).toBe("fix the bug")
  })

  it("elides text longer than the cap", () => {
    const long = "x".repeat(MAX_SUBJECT_LENGTH + 20)
    const truncated = truncateForLine(long)
    expect(truncated).toHaveLength(MAX_SUBJECT_LENGTH)
    expect(truncated.endsWith("…")).toBe(true)
  })

  it("leaves text at the cap untouched", () => {
    const exact = "y".repeat(MAX_SUBJECT_LENGTH)
    expect(truncateForLine(exact)).toBe(exact)
  })
})

describe("formatTaskLine", () => {
  it("marks the highlighted task and shows in-progress elapsed time", () => {
    const running = task("a1", "in_progress", { elapsedMs: 12 * 60_000 })
    expect(formatTaskLine(running, [running], true)).toBe("  → #a1  Task a1 (12m)")
  })

  it("names the open blockers of a blocked task", () => {
    const tasks = [task("a1", "in_progress"), blocked("a2", ["a1"])]
    expect(formatTaskLine(tasks[1]!, tasks)).toBe("    #a2  Task a2 (blocked by #a1)")
  })

  it("shows how much open work an in-progress task holds up", () => {
    const tasks = [task("a1", "in_progress"), blocked("a2", ["a1"]), blocked("a3", ["a1"])]
    expect(formatTaskLine(tasks[0]!, tasks)).toContain("unblocks 2")
  })

  it("flags in-progress work started while still blocked", () => {
    const tasks = [task("a1", "pending"), task("a2", "in_progress", { blockedBy: ["a1"] })]
    expect(formatTaskLine(tasks[1]!, tasks)).toContain("started while blocked by #a1")
  })

  it("flags in-progress work left running past the stale threshold", () => {
    const stale = task("a1", "in_progress", { elapsedMs: STALE_IN_PROGRESS_MS })
    expect(formatTaskLine(stale, [stale])).toContain("stalled — finish, split, or cancel")
  })

  it("does not call fresh in-progress work stalled", () => {
    const fresh = task("a1", "in_progress", { elapsedMs: STALE_IN_PROGRESS_MS - 60_000 })
    expect(formatTaskLine(fresh, [fresh])).not.toContain("stalled")
  })
})

describe("countTasksFreedBy", () => {
  it("counts only tasks this one is the last blocker for", () => {
    const tasks = [
      task("a1", "in_progress"),
      task("a2", "pending"),
      blocked("a3", ["a1"]),
      // a4 still waits on a2 as well, so finishing a1 does not free it.
      blocked("a4", ["a1", "a2"]),
    ]
    const byId = new Map(tasks.map((t) => [t.id, t]))

    expect(countTasksFreedBy(tasks[0]!, tasks, byId)).toBe(1)
  })

  it("ignores completed dependants", () => {
    const tasks = [task("a1", "in_progress"), task("a2", "completed", { blockedBy: ["a1"] })]
    const byId = new Map(tasks.map((t) => [t.id, t]))

    expect(countTasksFreedBy(tasks[0]!, tasks, byId)).toBe(0)
  })
})

describe("findDependencyCycle", () => {
  it("finds a two-task deadlock", () => {
    const cycle = findDependencyCycle([blocked("a", ["b"]), blocked("b", ["a"])])
    expect(cycle?.sort()).toEqual(["a", "b"])
  })

  it("finds a longer loop", () => {
    const cycle = findDependencyCycle([
      blocked("a", ["b"]),
      blocked("b", ["c"]),
      blocked("c", ["a"]),
    ])
    expect(cycle?.sort()).toEqual(["a", "b", "c"])
  })

  it("returns null for an acyclic chain", () => {
    // Control: a plain chain must not be reported, or the deadlock warning is meaningless.
    expect(findDependencyCycle([task("a", "in_progress"), blocked("b", ["a"])])).toBeNull()
  })

  it("ignores a loop whose tasks are already finished", () => {
    const done = [
      task("a", "completed", { blockedBy: ["b"] }),
      task("b", "completed", { blockedBy: ["a"] }),
    ]
    expect(findDependencyCycle(done)).toBeNull()
  })
})

describe("findNewlyUnblockedTasks", () => {
  it("reports a task freed by its blocker completing", () => {
    const before = [task("a", "in_progress"), blocked("b", ["a"])]
    const after = [task("a", "completed"), blocked("b", ["a"])]

    expect(findNewlyUnblockedTasks(before, after).map((t) => t.id)).toEqual(["b"])
  })

  it("stays quiet while another blocker is still open", () => {
    const before = [task("a", "in_progress"), task("c", "pending"), blocked("b", ["a", "c"])]
    const after = [task("a", "completed"), task("c", "pending"), blocked("b", ["a", "c"])]

    expect(findNewlyUnblockedTasks(before, after)).toEqual([])
  })

  it("reports a task freed by removing the blocking edge", () => {
    const before = [task("a", "in_progress"), blocked("b", ["a"])]
    const after = [task("a", "in_progress"), blocked("b", [])]

    expect(findNewlyUnblockedTasks(before, after).map((t) => t.id)).toEqual(["b"])
  })

  it("ignores tasks that were never blocked", () => {
    // Control: without this, an "unblocked" line could fire for every open task in the store.
    const before = [task("a", "in_progress"), task("b", "pending")]
    const after = [task("a", "completed"), task("b", "pending")]

    expect(findNewlyUnblockedTasks(before, after)).toEqual([])
  })

  it("ignores a blockedBy id that names no known task", () => {
    expect(findNewlyUnblockedTasks([blocked("b", ["gone"])], [blocked("b", ["gone"])])).toEqual([])
  })

  it("ignores a freed task that is itself already finished", () => {
    const before = [task("a", "in_progress"), task("b", "completed", { blockedBy: ["a"] })]
    const after = [task("a", "completed"), task("b", "completed", { blockedBy: ["a"] })]

    expect(findNewlyUnblockedTasks(before, after)).toEqual([])
  })
})

describe("renderUnblockedLine", () => {
  it("returns null when nothing was freed", () => {
    expect(renderUnblockedLine([])).toBeNull()
  })

  it("names the freed task", () => {
    expect(renderUnblockedLine([task("b", "pending", { subject: "Wire the renderer" })])).toBe(
      "Unblocked: #b Wire the renderer — ready to start."
    )
  })

  it("caps the named tasks and counts the rest", () => {
    const freed = Array.from({ length: 6 }, (_, i) => task(`f${i}`, "pending"))
    const line = renderUnblockedLine(freed)

    expect(line).toContain("#f0")
    expect(line).toContain("(+3 more)")
    expect(line).not.toContain("#f4")
  })
})

describe("renderTaskBoard", () => {
  it("separates startable pending work from blocked pending work", () => {
    const tasks = [task("a1", "in_progress"), task("a2", "pending"), blocked("a3", ["a1"])]

    const board = renderTaskBoard(tasks, "a1")

    expect(board).toContain("IN PROGRESS (1)")
    expect(board).toContain("→ #a1  Task a1 (unblocks 1)")
    expect(board).toContain("READY (1)")
    expect(board).toContain("BLOCKED (1)")
    expect(board).toContain("Totals: 3 task(s) — 3 open, 1 in progress, 1 ready, 1 blocked")
  })

  it("counts finished work instead of listing it", () => {
    const tasks = [
      task("1", "in_progress"),
      task("2", "pending"),
      ...Array.from({ length: 30 }, (_, i) => task(`c${i}`, "completed", { completedAt: i })),
    ]

    const board = renderTaskBoard(tasks)

    expect(board).toContain("RECENTLY COMPLETED (30)")
    expect(board).toContain("#c29 Task c29")
    expect(board).toContain("(+27 more)")
    expect(board).not.toContain("#c0 Task c0")
  })

  it("caps each open group and states how many were withheld", () => {
    const pending = Array.from({ length: MAX_LISTED_PER_GROUP + 5 }, (_, i) =>
      task(`p${i}`, "pending")
    )

    const board = renderTaskBoard([task("run", "in_progress"), ...pending])
    const listed = board.split("\n").filter((line) => line.includes("#p")).length

    expect(listed).toBe(MAX_LISTED_PER_GROUP)
    expect(board).toContain("+5 more ready")
  })

  it("stays bounded regardless of task count", () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      task(`t${i}`, i % 2 === 0 ? "completed" : "pending")
    )

    expect(renderTaskBoard(many).split("\n").length).toBeLessThan(25)
  })

  it("reports cancelled tasks only when some exist", () => {
    expect(renderTaskBoard([task("1", "pending"), task("2", "in_progress")])).not.toContain(
      "cancelled"
    )
    expect(renderTaskBoard([task("1", "cancelled")])).toContain("1 cancelled")
  })
})

describe("taskQueueHint", () => {
  it("flags an empty queue that will block the next tool call", () => {
    expect(taskQueueHint([])).toContain("TaskCreate")
  })

  it("names the task to start when nothing is in progress", () => {
    const hint = taskQueueHint([task("a1", "pending", { subject: "Fix login" })])
    expect(hint).toBe('Start next: TaskUpdate #a1 status:"in_progress" — Fix login.')
  })

  it("suggests the startable task that frees the most work", () => {
    const tasks = [task("a1", "pending"), task("a2", "pending"), blocked("a3", ["a2"])]
    expect(taskQueueHint(tasks)).toContain("#a2")
  })

  it("points at the root of a blocked chain rather than a blocked task", () => {
    // a2 waits on a3; a3 is free, so a3 is what the caller should start.
    const hint = taskQueueHint([blocked("a2", ["a3"]), task("a3", "pending")])
    expect(hint).toContain('TaskUpdate #a3 status:"in_progress"')
  })

  it("names the blocker when every pending task waits on in-progress work", () => {
    const hint = taskQueueHint([task("a1", "in_progress"), blocked("a2", ["a1"])])
    expect(hint).toBe("Every pending task is blocked — finishing #a1 is what moves the queue.")
  })

  it("asks for a follow-on step when only in-progress work remains", () => {
    expect(taskQueueHint([task("a1", "in_progress")])).toContain("No pending task queued")
  })

  it("reports a dependency cycle ahead of any other advice", () => {
    const hint = taskQueueHint([blocked("a", ["b"]), blocked("b", ["a"])])
    expect(hint).toContain("Dependency cycle:")
    expect(hint).toContain("drop one blockedBy edge")
  })

  it("stays silent when the queue is healthy", () => {
    expect(taskQueueHint([task("a1", "in_progress"), task("a2", "pending")])).toBeNull()
  })
})

describe("renderTaskToolResult", () => {
  it("leads with the confirmation, then the board", () => {
    const text = renderTaskToolResult("Created #7 — Fix login", [task("7", "pending")], "7")
    const [headline, blank] = text.split("\n")

    expect(headline).toBe("Created #7 — Fix login")
    expect(blank).toBe("")
    expect(text).toContain("READY (1)")
  })
})
