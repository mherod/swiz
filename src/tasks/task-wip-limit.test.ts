import { describe, expect, test } from "bun:test"
import { checkInProgressLimit, MAX_IN_PROGRESS_TASKS_PER_PROJECT } from "./task-wip-limit.ts"

function inProgress(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `sess-${i + 1}`,
    status: "in_progress",
    subject: `Task ${i + 1}`,
  }))
}

describe("checkInProgressLimit", () => {
  test("allows a transition into in_progress below the cap", () => {
    const tasks = [
      ...inProgress(MAX_IN_PROGRESS_TASKS_PER_PROJECT - 1),
      { id: "x", status: "pending" },
    ]
    expect(checkInProgressLimit("x", "pending", "in_progress", tasks)).toBeNull()
  })

  test("blocks a transition that would exceed the cap", () => {
    const tasks = [...inProgress(MAX_IN_PROGRESS_TASKS_PER_PROJECT), { id: "x", status: "pending" }]
    const error = checkInProgressLimit("x", "pending", "in_progress", tasks)
    expect(error).toContain("Cannot move #x to in_progress")
    expect(error).toContain(`limit ${MAX_IN_PROGRESS_TASKS_PER_PROJECT}`)
    expect(error).toContain("#sess-1: Task 1")
    // A pending task is told about the evidenced close, which is exempt from the cap (#930).
    expect(error).toContain("complete it directly with the evidence")
  })

  test("names the evidenced close only for a pending task", () => {
    const tasks = [
      ...inProgress(MAX_IN_PROGRESS_TASKS_PER_PROJECT),
      { id: "x", status: "completed" },
    ]
    // A reopen from completed has no one-step close to offer.
    expect(checkInProgressLimit("x", "completed", "in_progress", tasks)).not.toContain(
      "complete it directly"
    )
  })

  test("blocks a reopen from completed when the project is already at the cap", () => {
    const tasks = [
      ...inProgress(MAX_IN_PROGRESS_TASKS_PER_PROJECT),
      { id: "x", status: "completed" },
    ]
    expect(checkInProgressLimit("x", "completed", "in_progress", tasks)).toContain(
      "Cannot move #x to in_progress"
    )
  })

  test("blocks when the project is already over the cap", () => {
    const tasks = inProgress(MAX_IN_PROGRESS_TASKS_PER_PROJECT + 2)
    const error = checkInProgressLimit("x", "pending", "in_progress", tasks)
    expect(error).toContain(`${MAX_IN_PROGRESS_TASKS_PER_PROJECT + 2} in_progress tasks`)
  })

  test("does not count the task itself", () => {
    const tasks = inProgress(MAX_IN_PROGRESS_TASKS_PER_PROJECT)
    // sess-1 is one of the in_progress tasks — staying in_progress is a no-op.
    expect(checkInProgressLimit("sess-1", "in_progress", "in_progress", tasks)).toBeNull()
  })

  test("leaves non-in_progress transitions alone at the cap", () => {
    const tasks = inProgress(MAX_IN_PROGRESS_TASKS_PER_PROJECT)
    expect(checkInProgressLimit("sess-1", "in_progress", "completed", tasks)).toBeNull()
    expect(checkInProgressLimit("sess-1", "in_progress", "cancelled", tasks)).toBeNull()
    expect(checkInProgressLimit("x", "cancelled", "pending", tasks)).toBeNull()
  })

  test("ignores incomplete tasks that are not in_progress", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({ id: `p-${i}`, status: "pending" }))
    expect(checkInProgressLimit("x", "pending", "in_progress", tasks)).toBeNull()
  })
})
