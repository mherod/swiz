import { describe, expect, test } from "bun:test"
import {
  countTasksFreedBy,
  findDependencyCycle,
  findNewlyUnblockedTasks,
  indexTasksById,
  isOpenStatus,
  openBlockersOf,
  partitionTasks,
  pickCriticalPathTask,
  type TopologyTask,
} from "./task-topology.ts"

function task(id: string, status: string, blockedBy: string[] = []): TopologyTask {
  return { id, status, blockedBy }
}

describe("partitionTasks", () => {
  test("splits pending into ready and blocked by open blockers only", () => {
    const tasks = [
      task("a", "in_progress"),
      task("b", "pending", ["a"]),
      task("c", "pending"),
      task("d", "pending", ["done"]),
      task("done", "completed"),
      task("e", "cancelled"),
    ]
    const partition = partitionTasks(tasks)
    expect(partition.inProgress.map((t) => t.id)).toEqual(["a"])
    expect(partition.ready.map((t) => t.id)).toEqual(["c", "d"])
    expect(partition.blocked.map((t) => t.id)).toEqual(["b"])
    expect(partition.completed.map((t) => t.id)).toEqual(["done"])
    expect(partition.cancelled.map((t) => t.id)).toEqual(["e"])
  })

  test("an unknown blocker id does not block — the edge may point at another session", () => {
    const partition = partitionTasks([task("b", "pending", ["missing"])])
    expect(partition.ready.map((t) => t.id)).toEqual(["b"])
    expect(partition.blocked).toEqual([])
  })

  test("every task lands in exactly one bucket", () => {
    const tasks = [
      task("a", "in_progress"),
      task("b", "pending", ["a"]),
      task("c", "pending"),
      task("d", "completed"),
      task("e", "cancelled"),
    ]
    const partition = partitionTasks(tasks)
    const bucketed = [
      ...partition.inProgress,
      ...partition.ready,
      ...partition.blocked,
      ...partition.completed,
      ...partition.cancelled,
    ]
    expect(bucketed).toHaveLength(tasks.length)
    expect(new Set(bucketed.map((t) => t.id)).size).toBe(tasks.length)
  })
})

describe("pickCriticalPathTask", () => {
  test("prefers the ready task that frees the most downstream work", () => {
    const tasks = [
      task("low", "pending"),
      task("high", "pending"),
      task("x", "pending", ["high"]),
      task("y", "pending", ["high"]),
    ]
    const { ready } = partitionTasks(tasks)
    expect(pickCriticalPathTask(ready, tasks)?.id).toBe("high")
  })

  test("ties keep queue order so a flat queue recommends the oldest ready task", () => {
    const tasks = [task("first", "pending"), task("second", "pending")]
    expect(pickCriticalPathTask(tasks, tasks)?.id).toBe("first")
  })

  test("returns null when nothing is startable", () => {
    expect(pickCriticalPathTask([], [task("a", "in_progress")])).toBeNull()
  })
})

describe("countTasksFreedBy", () => {
  test("counts only tasks whose sole remaining blocker is this one", () => {
    const tasks = [
      task("a", "in_progress"),
      task("b", "in_progress"),
      task("sole", "pending", ["a"]),
      task("shared", "pending", ["a", "b"]),
    ]
    const byId = indexTasksById(tasks)
    expect(countTasksFreedBy(tasks[0]!, tasks, byId)).toBe(1)
  })
})

describe("findDependencyCycle", () => {
  test("reports a live two-task deadlock", () => {
    const cycle = findDependencyCycle([task("a", "pending", ["b"]), task("b", "pending", ["a"])])
    expect(cycle?.sort()).toEqual(["a", "b"])
  })

  test("edges through completed tasks are not a deadlock", () => {
    const cycle = findDependencyCycle([task("a", "pending", ["b"]), task("b", "completed", ["a"])])
    expect(cycle).toBeNull()
  })
})

describe("findNewlyUnblockedTasks", () => {
  test("names the task freed when its last blocker completes", () => {
    const before = [task("a", "in_progress"), task("b", "pending", ["a"])]
    const after = [task("a", "completed"), task("b", "pending", ["a"])]
    expect(findNewlyUnblockedTasks(before, after).map((t) => t.id)).toEqual(["b"])
  })
})

describe("isOpenStatus", () => {
  test("only pending and in_progress are open", () => {
    expect(isOpenStatus("pending")).toBe(true)
    expect(isOpenStatus("in_progress")).toBe(true)
    expect(isOpenStatus("completed")).toBe(false)
    expect(isOpenStatus("cancelled")).toBe(false)
  })
})

describe("openBlockersOf", () => {
  test("drops blockers that already finished", () => {
    const tasks = [task("done", "completed"), task("live", "pending")]
    const subject = task("x", "pending", ["done", "live"])
    expect(openBlockersOf(subject, indexTasksById([...tasks, subject]))).toEqual(["live"])
  })
})
