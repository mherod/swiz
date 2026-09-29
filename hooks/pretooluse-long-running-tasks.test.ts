import { describe, expect, test } from "bun:test"
import {
  findLongRunningActiveTasks,
  LONG_RUNNING_ACTIVE_TASK_MS,
} from "./pretooluse-task-governance.ts"

const NOW = Date.parse("2026-09-29T12:00:00.000Z")
const iso = (ms: number) => new Date(ms).toISOString()
const HOUR = LONG_RUNNING_ACTIVE_TASK_MS

describe("findLongRunningActiveTasks", () => {
  test("flags an in_progress task started over an hour ago with no refresh", () => {
    const started = NOW - HOUR - 60_000
    const tasks = [
      {
        id: "1",
        status: "in_progress",
        subject: "Old",
        statusChangedAt: iso(started),
        updatedAt: iso(started),
      },
    ]
    expect(findLongRunningActiveTasks(tasks, NOW).map((t) => t.id)).toEqual(["1"])
  })

  test("releases a long-running task refreshed within the last hour", () => {
    const started = NOW - 3 * HOUR
    const tasks = [
      {
        id: "1",
        status: "in_progress",
        subject: "Old",
        statusChangedAt: iso(started),
        updatedAt: iso(NOW - 60_000),
      },
    ]
    expect(findLongRunningActiveTasks(tasks, NOW)).toEqual([])
  })

  test("ignores tasks under an hour and non-active tasks", () => {
    const old = iso(NOW - 2 * HOUR)
    const tasks = [
      { id: "1", status: "in_progress", subject: "Fresh", statusChangedAt: iso(NOW - 60_000) },
      { id: "2", status: "pending", subject: "Queued", statusChangedAt: old, updatedAt: old },
      { id: "3", status: "completed", subject: "Done", statusChangedAt: old, updatedAt: old },
    ]
    expect(findLongRunningActiveTasks(tasks, NOW)).toEqual([])
  })
})
