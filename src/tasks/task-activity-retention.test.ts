import { describe, expect, it } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { partitionStaleOpenTasks } from "../../hooks/pretooluse-task-governance.ts"
import { readProjectTasksWithPrune } from "../mcp-tool-core.ts"
import { useTempDir } from "../utils/test-utils.ts"
import {
  COMPLETED_TASK_PRUNE_AGE_MS,
  OPEN_TASK_ABANDONED_CEILING_MS,
  OPEN_TASK_UPDATE_RECENCY_LIMIT_MS,
  STALE_TASK_PRUNE_AGE_MS,
} from "./task-governance-constants.ts"
import { pruneStaleCompletedTasks } from "./task-prune.ts"
import { TaskStateCache } from "./task-state-cache.ts"
import {
  getTaskCurrentDurationMs,
  getTaskLastUpdatedMs,
  type TaskTimingLike,
} from "./task-timing.ts"

const tmp = useTempDir("swiz-task-activity-")
const THREE_DAYS_MS = 3 * 24 * 60 * 60_000

interface FixtureTask extends TaskTimingLike {
  id: string
  subject: string
  description: string
  blocks: string[]
  blockedBy: string[]
}

function fixture(id: string, timing: TaskTimingLike): FixtureTask {
  return { id, subject: `Task ${id}`, description: "", blocks: [], blockedBy: [], ...timing }
}

function activityRecords(now: number): FixtureTask[] {
  const old = new Date(now - THREE_DAYS_MS).toISOString()
  const fresh = new Date(now).toISOString()
  return [
    fixture("1", { status: "pending", statusChangedAt: old, updatedAt: fresh }),
    fixture("2", {
      status: "in_progress",
      statusChangedAt: old,
      startedAt: now - THREE_DAYS_MS,
      updatedAt: fresh,
    }),
    fixture("3", { status: "pending", statusChangedAt: old, updatedAt: old }),
    fixture("4", { status: "pending" }),
    fixture("5", { status: "pending", statusChangedAt: fresh, updatedAt: "invalid" }),
    fixture("6", {
      status: "in_progress",
      statusChangedAt: old,
      startedAt: now - THREE_DAYS_MS,
    }),
    fixture("7", { status: "cancelled", statusChangedAt: old, completedAt: now }),
    fixture("8", {
      status: "completed",
      completedAt: now - COMPLETED_TASK_PRUNE_AGE_MS - 60_000,
      updatedAt: fresh,
    }),
    fixture("9", { status: "completed", completedAt: now, updatedAt: fresh }),
    fixture("10", { status: "in_progress", statusChangedAt: old, startedAt: now }),
    fixture("11", { status: "pending", updatedAt: old }),
    fixture("12", { status: "pending", statusChangedAt: "invalid", updatedAt: "invalid" }),
  ]
}

async function seed(dir: string, tasks: FixtureTask[]): Promise<void> {
  await mkdir(dir, { recursive: true })
  for (const task of tasks) await Bun.write(join(dir, `${task.id}.json`), JSON.stringify(task))
}

async function expectSurvivors(dir: string, tasks: { id: string }[]): Promise<void> {
  const expected = ["1", "2", "4", "5", "7", "9", "10", "12"]
  expect(tasks.map((task) => task.id).sort()).toEqual([...expected].sort())
  for (let id = 1; id <= 12; id++) {
    expect(await Bun.file(join(dir, `${id}.json`)).exists()).toBe(expected.includes(String(id)))
  }
}

describe("task activity retention", () => {
  it("orders the open-task lifecycle without changing its thresholds", () => {
    expect(OPEN_TASK_UPDATE_RECENCY_LIMIT_MS).toBe(10 * 60_000)
    expect(OPEN_TASK_ABANDONED_CEILING_MS).toBe(60 * 60_000)
    expect(STALE_TASK_PRUNE_AGE_MS).toBe(2 * 24 * 60 * 60_000)
    expect(COMPLETED_TASK_PRUNE_AGE_MS).toBe(15 * 60_000)
    expect(OPEN_TASK_UPDATE_RECENCY_LIMIT_MS).toBeLessThan(OPEN_TASK_ABANDONED_CEILING_MS)
    expect(OPEN_TASK_ABANDONED_CEILING_MS).toBeLessThan(STALE_TASK_PRUNE_AGE_MS)
  })

  it("preserves recently maintained records through leaf pruning", async () => {
    const dir = await tmp.create()
    const tasks = activityRecords(Date.now())
    await seed(dir, tasks)
    await expectSurvivors(dir, await pruneStaleCompletedTasks(dir, tasks))
  })

  it("preserves recently maintained records through project MCP reads", async () => {
    const tasksDir = await tmp.create()
    const key = "project-activity"
    const dir = join(tasksDir, key)
    await seed(dir, activityRecords(Date.now()))
    await expectSurvivors(dir, await readProjectTasksWithPrune(key, tasksDir))
    expect((await Bun.file(join(dir, ".session-meta.json")).json()).openCount).toBe(6)
  })

  it("preserves recently maintained records through session cache full loads", async () => {
    const dir = await tmp.create()
    const cache = new TaskStateCache()
    await seed(dir, activityRecords(Date.now()))
    try {
      const state = await cache.getState(`activity-${dir}`, dir)
      await expectSurvivors(dir, state.tasks)
      expect(state.openCount).toBe(6)
      expect((await Bun.file(join(dir, ".session-meta.json")).json()).openCount).toBe(6)
    } finally {
      cache.close()
    }
  })

  it("gives the recency gate and pruning identical ages for shared records", async () => {
    const now = Date.now()
    const tasks = activityRecords(now).filter(
      (task) => task.status === "pending" || task.status === "in_progress"
    )
    const dir = await tmp.create()
    await seed(dir, tasks)
    const partition = partitionStaleOpenTasks(tasks, now)
    expect(partition.blocking).toEqual([])
    expect(partition.abandoned.map((task) => task.id)).toEqual(["3", "6", "11"])

    // Equal cutoffs expose timestamp disagreement independently of the policies' durations.
    const gateAtPruneAge = partitionStaleOpenTasks(
      tasks,
      now,
      STALE_TASK_PRUNE_AGE_MS,
      Number.POSITIVE_INFINITY
    ).blocking
    const survivors = await pruneStaleCompletedTasks(dir, tasks)
    expect(tasks.filter((task) => !survivors.includes(task))).toEqual(gateAtPruneAge)
  })
})

describe("shared last-activity resolution", () => {
  it("prefers write activity while keeping elapsed duration independent", () => {
    const now = Date.now()
    const task = activityRecords(now)[1]!
    expect(getTaskLastUpdatedMs(task)).toBe(now)
    expect(getTaskCurrentDurationMs(task, now)).toBe(THREE_DAYS_MS)
  })

  it("keeps the write timestamp authoritative when present", () => {
    expect(
      getTaskLastUpdatedMs({
        status: "pending",
        updatedAt: new Date(1_000).toISOString(),
        statusChangedAt: new Date(2_000).toISOString(),
      })
    ).toBe(1_000)
  })

  it("uses the newest valid legacy activity when updatedAt is missing or invalid", () => {
    for (const updatedAt of [undefined, null, "invalid"]) {
      for (const newest of ["statusChangedAt", "startedAt", "completedAt"] as const) {
        const task: TaskTimingLike = {
          status: "pending",
          updatedAt,
          statusChangedAt: new Date(1_000).toISOString(),
          startedAt: 1_000,
          completedAt: 1_000,
        }
        if (newest === "statusChangedAt") task[newest] = new Date(2_000).toISOString()
        else task[newest] = 2_000
        expect(getTaskLastUpdatedMs(task)).toBe(2_000)
      }
    }
  })

  it("returns unknown for records with no usable activity", () => {
    expect(getTaskLastUpdatedMs({ status: "pending" })).toBeNull()
    expect(
      getTaskLastUpdatedMs({
        status: "pending",
        updatedAt: "invalid",
        statusChangedAt: "invalid",
        startedAt: Number.NaN,
        completedAt: Number.POSITIVE_INFINITY,
      })
    ).toBeNull()
  })

  it("uses numeric legacy activity without a status timestamp", () => {
    expect(getTaskLastUpdatedMs({ status: "in_progress", startedAt: 1_000 })).toBe(1_000)
    expect(getTaskLastUpdatedMs({ status: "cancelled", completedAt: 2_000 })).toBe(2_000)
  })
})
