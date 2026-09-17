import { describe, expect, it } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pruneStaleCompletedTasks } from "./task-prune.ts"

interface FixtureTask {
  id: string
  status: string
  startedAt?: number | null
  completedAt?: number | null
  statusChangedAt?: string | null
}

const TWO_DAYS_MS = 2 * 24 * 60 * 60_000
/** Comfortably past the 2-day retention age, so the rule fires deterministically. */
const LONG_AGO_MS = TWO_DAYS_MS + 60 * 60_000
/** The production completed-task retention, passed through when exercising the age rule. */
const COMPLETED_AGE_MS = 15 * 60_000

async function makeStoreDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "swiz-task-prune-"))
}

async function writeTaskFile(dir: string, task: FixtureTask): Promise<void> {
  await writeFile(join(dir, `${task.id}.json`), JSON.stringify(task))
}

function fileExists(dir: string, id: string): Promise<boolean> {
  return Bun.file(join(dir, `${id}.json`)).exists()
}

describe("pruneStaleCompletedTasks", () => {
  it("deletes completed files older than the retention age and returns survivors", async () => {
    const dir = await makeStoreDir()
    const maxAgeMs = 1_000
    const tasks: FixtureTask[] = [
      { id: "1", status: "completed", completedAt: Date.now() - 5_000 },
      { id: "2", status: "completed", completedAt: Date.now() },
      { id: "3", status: "pending" },
      { id: "4", status: "in_progress" },
      { id: "5", status: "cancelled" },
    ]
    for (const task of tasks) await writeTaskFile(dir, task)

    const surviving = await pruneStaleCompletedTasks(dir, tasks, maxAgeMs)

    expect(surviving.map((t) => t.id)).toEqual(["2", "3", "4", "5"])
    expect(await fileExists(dir, "1")).toBe(false)
    for (const id of ["2", "3", "4", "5"]) {
      expect(await fileExists(dir, id)).toBe(true)
    }
  })

  it("keeps completed tasks with no usable completedAt", async () => {
    const dir = await makeStoreDir()
    const tasks: FixtureTask[] = [
      { id: "1", status: "completed" },
      { id: "2", status: "completed", completedAt: null },
    ]
    for (const task of tasks) await writeTaskFile(dir, task)

    const surviving = await pruneStaleCompletedTasks(dir, tasks, 0)

    expect(surviving.map((t) => t.id)).toEqual(["1", "2"])
    expect(await fileExists(dir, "1")).toBe(true)
    expect(await fileExists(dir, "2")).toBe(true)
  })

  it("drops a stale completed task from the result even when its file is already gone", async () => {
    const dir = await makeStoreDir()
    const tasks: FixtureTask[] = [{ id: "1", status: "completed", completedAt: Date.now() - 5_000 }]

    const surviving = await pruneStaleCompletedTasks(dir, tasks, 1_000)

    expect(surviving).toEqual([])
  })
})

describe("pruneStaleCompletedTasks — 2-day age rule", () => {
  function isoAgo(ms: number): string {
    return new Date(Date.now() - ms).toISOString()
  }

  it("deletes tasks of every status whose last activity predates the retention age", async () => {
    const dir = await makeStoreDir()
    const tasks: FixtureTask[] = [
      { id: "1", status: "pending", statusChangedAt: isoAgo(LONG_AGO_MS) },
      { id: "2", status: "in_progress", statusChangedAt: isoAgo(LONG_AGO_MS) },
      { id: "3", status: "cancelled", statusChangedAt: isoAgo(LONG_AGO_MS) },
      { id: "4", status: "completed", statusChangedAt: isoAgo(LONG_AGO_MS) },
    ]
    for (const task of tasks) await writeTaskFile(dir, task)

    const surviving = await pruneStaleCompletedTasks(dir, tasks)

    expect(surviving).toEqual([])
    for (const task of tasks) {
      expect(await fileExists(dir, task.id)).toBe(false)
    }
  })

  // Control for the test above: the same statuses must survive when recent, so
  // an all-empty result there cannot pass just because the rule deletes everything.
  it("keeps tasks of every status whose last activity is within the retention age", async () => {
    const dir = await makeStoreDir()
    const recent = isoAgo(60 * 60_000)
    const tasks: FixtureTask[] = [
      { id: "1", status: "pending", statusChangedAt: recent },
      { id: "2", status: "in_progress", statusChangedAt: recent },
      { id: "3", status: "cancelled", statusChangedAt: recent },
    ]
    for (const task of tasks) await writeTaskFile(dir, task)

    const surviving = await pruneStaleCompletedTasks(dir, tasks)

    expect(surviving.map((t) => t.id)).toEqual(["1", "2", "3"])
    for (const task of tasks) {
      expect(await fileExists(dir, task.id)).toBe(true)
    }
  })

  it("anchors age on the most recent timestamp, not the oldest", async () => {
    const dir = await makeStoreDir()
    const tasks: FixtureTask[] = [
      {
        id: "1",
        status: "in_progress",
        statusChangedAt: isoAgo(LONG_AGO_MS),
        startedAt: Date.now() - 60 * 60_000,
      },
    ]
    for (const task of tasks) await writeTaskFile(dir, task)

    const surviving = await pruneStaleCompletedTasks(dir, tasks)

    expect(surviving.map((t) => t.id)).toEqual(["1"])
    expect(await fileExists(dir, "1")).toBe(true)
  })

  it("keeps an undatable task rather than guessing its age", async () => {
    const dir = await makeStoreDir()
    const tasks: FixtureTask[] = [
      { id: "1", status: "pending" },
      { id: "2", status: "in_progress", statusChangedAt: null, startedAt: null },
      { id: "3", status: "pending", statusChangedAt: "not-a-date" },
    ]
    for (const task of tasks) await writeTaskFile(dir, task)

    const surviving = await pruneStaleCompletedTasks(dir, tasks)

    expect(surviving.map((t) => t.id)).toEqual(["1", "2", "3"])
    for (const task of tasks) {
      expect(await fileExists(dir, task.id)).toBe(true)
    }
  })

  it("honours an explicit stale retention override", async () => {
    const dir = await makeStoreDir()
    const tasks: FixtureTask[] = [{ id: "1", status: "pending", statusChangedAt: isoAgo(5_000) }]
    for (const task of tasks) await writeTaskFile(dir, task)

    const kept = await pruneStaleCompletedTasks(dir, tasks, COMPLETED_AGE_MS, 60_000)
    expect(kept.map((t) => t.id)).toEqual(["1"])

    const pruned = await pruneStaleCompletedTasks(dir, tasks, COMPLETED_AGE_MS, 1_000)
    expect(pruned).toEqual([])
    expect(await fileExists(dir, "1")).toBe(false)
  })
})
