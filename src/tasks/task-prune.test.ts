import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pruneStaleCompletedTasks } from "./task-prune.ts"
import {
  readSessionMeta,
  refreshSessionMetaFromDisk,
  updateSessionMetaFromTasks,
} from "./task-repository.ts"

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

describe("pruneStaleCompletedTasks metadata refresh", () => {
  it("refreshes openCount after deleting open tasks and skips no-op writes", async () => {
    const dir = await makeStoreDir()
    const stale = { id: "1", status: "pending", statusChangedAt: new Date(0).toISOString() }
    const survivor = { id: "2", status: "in_progress", statusChangedAt: new Date().toISOString() }
    await writeTaskFile(dir, stale)
    await writeTaskFile(dir, survivor)
    await updateSessionMetaFromTasks(dir, [stale, survivor], "session")

    let refreshCalls = 0
    const refreshed = await pruneStaleCompletedTasks(
      dir,
      [stale, survivor],
      TWO_DAYS_MS,
      TWO_DAYS_MS,
      async () => {
        refreshCalls++
        await refreshSessionMetaFromDisk(dir, "session")
      }
    )

    expect(refreshed.map((task) => task.id)).toEqual(["2"])
    expect((await Bun.file(join(dir, ".session-meta.json")).json()).openCount).toBe(1)
    expect(refreshCalls).toBe(1)

    await pruneStaleCompletedTasks(dir, refreshed, TWO_DAYS_MS, TWO_DAYS_MS, async () => {
      refreshCalls++
    })
    expect(refreshCalls).toBe(1)
  })

  it("counts a task written after the snapshot instead of publishing an undercount", async () => {
    const dir = await makeStoreDir()
    const stale = { id: "1", status: "pending", statusChangedAt: new Date(0).toISOString() }
    await writeTaskFile(dir, stale)

    // The snapshot the prune was handed. A concurrent writer lands task "3"
    // after it is taken — publishing the snapshot would report openCount 0,
    // which collectIncompleteTasks treats as authoritative.
    const snapshot = [stale]
    const refreshed = await pruneStaleCompletedTasks(
      dir,
      snapshot,
      TWO_DAYS_MS,
      TWO_DAYS_MS,
      async () => {
        await writeTaskFile(dir, {
          id: "3",
          status: "in_progress",
          statusChangedAt: new Date().toISOString(),
        })
        await refreshSessionMetaFromDisk(dir, "session")
      }
    )

    expect(refreshed).toEqual([])
    expect((await Bun.file(join(dir, ".session-meta.json")).json()).openCount).toBe(1)
  })

  it("lets a memoized metadata read see the refreshed count", async () => {
    const tasksDir = await mkdtemp(join(tmpdir(), "swiz-task-prune-store-"))
    const sessionId = "swiz-prune-cache-session"
    const dir = join(tasksDir, sessionId)
    await mkdir(dir, { recursive: true })

    const stale = { id: "1", status: "pending", statusChangedAt: new Date(0).toISOString() }
    const survivor = { id: "2", status: "in_progress", statusChangedAt: new Date().toISOString() }
    await writeTaskFile(dir, stale)
    await writeTaskFile(dir, survivor)
    await updateSessionMetaFromTasks(dir, [stale, survivor], "session")

    // Memoize the pre-prune count, as a long-lived daemon process would.
    expect((await readSessionMeta(sessionId, tasksDir))?.openCount).toBe(2)

    await pruneStaleCompletedTasks(dir, [stale, survivor], TWO_DAYS_MS, TWO_DAYS_MS, () =>
      refreshSessionMetaFromDisk(dir, "session")
    )

    // Without invalidation this still returns the cached 2 until an unrelated
    // task write happens to evict the entry.
    expect((await readSessionMeta(sessionId, tasksDir))?.openCount).toBe(1)

    // Control: the non-invalidating writer leaves the memoized 1 in place, so
    // the assertion above is about invalidation, not about an inactive cache.
    await updateSessionMetaFromTasks(dir, [], "session")
    expect((await readSessionMeta(sessionId, tasksDir))?.openCount).toBe(1)
  })

  it("keeps reading tasks when the metadata refresh throws", async () => {
    const dir = await makeStoreDir()
    const stale = { id: "1", status: "pending", statusChangedAt: new Date(0).toISOString() }
    const survivor = { id: "2", status: "in_progress", statusChangedAt: new Date().toISOString() }
    await writeTaskFile(dir, stale)
    await writeTaskFile(dir, survivor)

    const pruned = await pruneStaleCompletedTasks(
      dir,
      [stale, survivor],
      TWO_DAYS_MS,
      TWO_DAYS_MS,
      async () => {
        throw new Error("read-only store")
      }
    )

    // Deletion is fail-open, so an auxiliary index write must not turn a
    // TaskStateCache load or MCP project read into a rejection.
    expect(pruned.map((task) => task.id)).toEqual(["2"])
    expect(await fileExists(dir, "1")).toBe(false)
  })

  it("keeps a record whose id cannot name a file in the store and reports no prune", async () => {
    const dir = await makeStoreDir()
    // `id` is record content, so a corrupt one can point outside the store.
    // Such a record is kept, which means nothing was pruned on its account.
    const corrupt = {
      id: "../escape",
      status: "pending",
      statusChangedAt: new Date(0).toISOString(),
    }
    const stale = { id: "1", status: "pending", statusChangedAt: new Date(0).toISOString() }
    await writeTaskFile(dir, stale)

    let refreshCalls = 0
    const keptOnly = await pruneStaleCompletedTasks(
      dir,
      [corrupt],
      TWO_DAYS_MS,
      TWO_DAYS_MS,
      async () => {
        refreshCalls++
      }
    )
    expect(keptOnly.map((task) => task.id)).toEqual(["../escape"])
    expect(refreshCalls).toBe(0)

    // Control: a genuinely prunable record alongside it still fires the refresh,
    // so the assertion above is about the guard, not about a dead callback.
    const mixed = await pruneStaleCompletedTasks(
      dir,
      [corrupt, stale],
      TWO_DAYS_MS,
      TWO_DAYS_MS,
      async () => {
        refreshCalls++
      }
    )
    expect(mixed.map((task) => task.id)).toEqual(["../escape"])
    expect(refreshCalls).toBe(1)
    expect(await fileExists(dir, "1")).toBe(false)
  })
})
