import { describe, expect, it } from "bun:test"
import { applyMutationOverlay } from "./posttooluse-task-count-context.ts"

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
