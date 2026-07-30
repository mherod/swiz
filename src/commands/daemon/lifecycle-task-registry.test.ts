import { describe, expect, test } from "bun:test"
import { LifecycleTaskRegistry } from "./lifecycle-task-registry.ts"

describe("LifecycleTaskRegistry", () => {
  test("records creation and removes only the matching completion", () => {
    const registry = new LifecycleTaskRegistry()
    expect(
      registry.recordCreated("/repo", "session-1", {
        taskId: "task-1",
        subject: "Compile assets",
        description: "Build the production bundle",
        teammateName: "worker-a",
        teamName: "frontend",
      })
    ).toBe(true)

    expect(registry.listActive("/repo", "session-1")).toEqual([
      expect.objectContaining({
        taskId: "task-1",
        subject: "Compile assets",
        description: "Build the production bundle",
        teammateName: "worker-a",
        teamName: "frontend",
      }),
    ])
    expect(registry.recordCompleted("/repo", "session-1", "unknown")).toBe(false)
    expect(registry.recordCompleted("/repo", "session-1", "task-1")).toBe(true)
    expect(registry.listActive("/repo", "session-1")).toEqual([])
  })

  test("deduplicates repeated creation while preserving original ordering time", () => {
    const registry = new LifecycleTaskRegistry()
    registry.recordCreated("/repo", "session-1", { taskId: "task-1", subject: "Old" }, 10)
    registry.recordCreated("/repo", "session-1", { taskId: "task-1", subject: "Updated" }, 20)

    expect(registry.listActive("/repo", "session-1")).toEqual([
      { taskId: "task-1", subject: "Updated", createdAt: 10 },
    ])
  })

  test("isolates projects and sessions", () => {
    const registry = new LifecycleTaskRegistry()
    registry.recordCreated("/repo-a", "session-1", { taskId: "task-1", subject: "A1" })
    registry.recordCreated("/repo-a", "session-2", { taskId: "task-1", subject: "A2" })
    registry.recordCreated("/repo-b", "session-1", { taskId: "task-1", subject: "B1" })

    expect(registry.listActive("/repo-a", "session-1").map((task) => task.subject)).toEqual(["A1"])
    expect(registry.listActive("/repo-a", "session-2").map((task) => task.subject)).toEqual(["A2"])
    expect(registry.listActive("/repo-b", "session-1").map((task) => task.subject)).toEqual(["B1"])

    registry.clearSession("session-1")
    expect(registry.listActive("/repo-a", "session-1")).toEqual([])
    expect(registry.listActive("/repo-b", "session-1")).toEqual([])
    expect(registry.listActive("/repo-a", "session-2")).toHaveLength(1)

    registry.recordCreated("/repo-b", "session-2", { taskId: "task-2", subject: "B2" })
    registry.clearProjectSession("/repo-a", "session-2")
    expect(registry.listActive("/repo-a", "session-2")).toEqual([])
    expect(registry.listActive("/repo-b", "session-2")).toHaveLength(1)

    registry.clearProject("/repo-a")
    expect(registry.size).toBe(1)
    registry.clear()
    expect(registry.size).toBe(0)
  })

  test("fails open on incomplete payloads", () => {
    const registry = new LifecycleTaskRegistry()
    expect(
      registry.recordCreated("/repo", "session-1", { taskId: "", subject: "Missing ID" })
    ).toBe(false)
    expect(
      registry.recordCreated("/repo", "", { taskId: "task-1", subject: "Missing session" })
    ).toBe(false)
    expect(registry.recordCompleted("/repo", "session-1", "")).toBe(false)
    expect(registry.size).toBe(0)
  })

  test("bounds active task retention by evicting the oldest entry", () => {
    const registry = new LifecycleTaskRegistry(2)
    registry.recordCreated("/repo", "session-1", { taskId: "task-1", subject: "First" })
    registry.recordCreated("/repo", "session-1", { taskId: "task-2", subject: "Second" })
    registry.recordCreated("/repo", "session-1", { taskId: "task-3", subject: "Third" })

    expect(registry.listActive("/repo", "session-1").map((task) => task.taskId)).toEqual([
      "task-2",
      "task-3",
    ])
  })
})
