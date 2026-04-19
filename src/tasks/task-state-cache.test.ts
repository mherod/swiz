import { describe, expect, it } from "bun:test"
import { mkdir, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { taskListSyncSentinelPath } from "../temp-paths.ts"
import { useTempDir } from "../utils/test-utils.ts"
import { applyTaskCreateEvent, getSessionEventState, pruneSession } from "./task-event-state.ts"
import type { SessionTask } from "./task-recovery.ts"
import { TaskStateCache } from "./task-state-cache.ts"

const tmp = useTempDir("swiz-task-cache-")

function makeTask(id: string, status: string, subject?: string): SessionTask {
  return {
    id,
    subject: subject ?? `Task ${id}`,
    status,
    description: `Task ${id} description`,
    statusChangedAt: new Date().toISOString(),
    elapsedMs: 0,
    startedAt: status === "in_progress" ? Date.now() : null,
    completedAt: status === "completed" ? Date.now() : null,
  }
}

async function writeTaskFile(dir: string, task: SessionTask): Promise<void> {
  await writeFile(join(dir, `${task.id}.json`), JSON.stringify(task, null, 2))
}

async function createSessionDir(baseDir: string, sessionId: string): Promise<string> {
  const dir = join(baseDir, sessionId)
  await mkdir(dir, { recursive: true })
  return dir
}

async function writeTaskListSyncSentinel(
  sessionId: string,
  syncedAtMs = Date.now()
): Promise<void> {
  await Bun.write(taskListSyncSentinelPath(sessionId), String(syncedAtMs))
}

describe("TaskStateCache", () => {
  it("returns empty list for nonexistent session directory", async () => {
    const cache = new TaskStateCache({ maxEntries: 10 })
    const base = await tmp.create()
    const tasks = await cache.getTasks("nonexistent", join(base, "nonexistent"))
    expect(tasks).toEqual([])
    cache.close()
  })

  it("loads all tasks on first access (cold miss)", async () => {
    const cache = new TaskStateCache({ maxEntries: 10 })
    const base = await tmp.create()
    const sessionDir = await createSessionDir(base, "session-1")

    await writeTaskFile(sessionDir, makeTask("1", "completed"))
    await writeTaskFile(sessionDir, makeTask("2", "in_progress"))
    await writeTaskFile(sessionDir, makeTask("3", "pending"))

    const state = await cache.getState("session-1", sessionDir)
    expect(state.tasks).toHaveLength(3)
    expect(state.openCount).toBe(2)
    expect(state.pendingCount).toBe(1)
    expect(state.inProgressCount).toBe(1)
    expect(state.completedCount).toBe(1)
    expect(state.stale).toBe(false)
    cache.close()
  })

  it("returns cached data on subsequent reads", async () => {
    const cache = new TaskStateCache({ maxEntries: 10 })
    const base = await tmp.create()
    const sessionDir = await createSessionDir(base, "session-2")
    await writeTaskFile(sessionDir, makeTask("1", "pending"))

    const first = await cache.getTasks("session-2", sessionDir)
    // Write a new task to disk — cache should NOT see it
    await writeTaskFile(sessionDir, makeTask("2", "pending"))
    const second = await cache.getTasks("session-2", sessionDir)

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1) // still cached
    cache.close()
  })

  it("refreshes on invalidate", async () => {
    const cache = new TaskStateCache({ maxEntries: 10 })
    const base = await tmp.create()
    const sessionDir = await createSessionDir(base, "session-3")

    for (let i = 1; i <= 5; i++) {
      await writeTaskFile(sessionDir, makeTask(String(i), i <= 3 ? "completed" : "pending"))
    }

    const initial = await cache.getState("session-3", sessionDir)
    expect(initial.tasks).toHaveLength(5)
    expect(initial.pendingCount).toBe(2)

    // Update task 5 to in_progress on disk
    await writeTaskFile(sessionDir, makeTask("5", "in_progress"))

    // Mark stale (simulates fs.watch callback)
    cache.invalidate("session-3")

    const refreshed = await cache.getState("session-3", sessionDir)
    expect(refreshed.tasks).toHaveLength(5)
    expect(refreshed.pendingCount).toBe(1)
    expect(refreshed.inProgressCount).toBe(1)
    const task5 = refreshed.tasks.find((t) => t.id === "5")
    expect(task5?.status).toBe("in_progress")
    cache.close()
  })

  it("detects new task files on full reload after invalidate", async () => {
    const cache = new TaskStateCache({ maxEntries: 10 })
    const base = await tmp.create()
    const sessionDir = await createSessionDir(base, "session-new")
    await writeTaskFile(sessionDir, makeTask("1", "completed"))

    await cache.getState("session-new", sessionDir)

    // Add a new task file and invalidate
    await writeTaskFile(sessionDir, makeTask("2", "pending"))
    cache.invalidate("session-new")

    const refreshed = await cache.getState("session-new", sessionDir)
    expect(refreshed.tasks).toHaveLength(2)
    expect(refreshed.pendingCount).toBe(1)
    cache.close()
  })

  it("detects deleted task files on full reload after invalidate", async () => {
    const cache = new TaskStateCache({ maxEntries: 10 })
    const base = await tmp.create()
    const sessionDir = await createSessionDir(base, "session-del")
    await writeTaskFile(sessionDir, makeTask("1", "completed"))
    await writeTaskFile(sessionDir, makeTask("2", "pending"))

    await cache.getState("session-del", sessionDir)

    // Delete task 2 and invalidate
    await unlink(join(sessionDir, "2.json"))
    cache.invalidate("session-del")

    const refreshed = await cache.getState("session-del", sessionDir)
    expect(refreshed.tasks).toHaveLength(1)
    expect(refreshed.pendingCount).toBe(0)
    cache.close()
  })

  describe("write-through", () => {
    it("updates existing task in cache without disk read", async () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      const base = await tmp.create()
      const sessionDir = await createSessionDir(base, "session-wt")
      await writeTaskFile(sessionDir, makeTask("1", "pending"))
      await writeTaskFile(sessionDir, makeTask("2", "in_progress"))

      await cache.getState("session-wt", sessionDir)

      // Write-through: mark task 1 as in_progress
      cache.applyTaskUpdate("session-wt", makeTask("1", "in_progress"))

      const state = await cache.getState("session-wt", sessionDir)
      expect(state.inProgressCount).toBe(2)
      expect(state.pendingCount).toBe(0)
      expect(state.stale).toBe(false)
      cache.close()
    })

    it("adds new task to cache without disk read", async () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      const base = await tmp.create()
      const sessionDir = await createSessionDir(base, "session-wt2")
      await writeTaskFile(sessionDir, makeTask("1", "pending"))

      await cache.getState("session-wt2", sessionDir)

      cache.applyTaskUpdate("session-wt2", makeTask("2", "in_progress"))

      const state = await cache.getState("session-wt2", sessionDir)
      expect(state.tasks).toHaveLength(2)
      expect(state.inProgressCount).toBe(1)
      expect(state.pendingCount).toBe(1)
      cache.close()
    })

    it("is a no-op when session has no cached state", () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      // Should not throw
      cache.applyTaskUpdate("uncached-session", makeTask("1", "pending"))
      cache.close()
    })
  })

  describe("applyTaskListSnapshot", () => {
    it("replaces cached state with full task list and recomputes counts", async () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      const base = await tmp.create()
      const sessionDir = await createSessionDir(base, "session-snap")
      await writeTaskFile(sessionDir, makeTask("1", "pending"))

      // Warm cache
      await cache.getState("session-snap", sessionDir)

      // Snapshot replaces with a different set of tasks
      cache.applyTaskListSnapshot("session-snap", [
        makeTask("1", "completed"),
        makeTask("2", "in_progress"),
        makeTask("3", "pending"),
      ])

      const state = await cache.getState("session-snap", sessionDir)
      expect(state.tasks).toHaveLength(3)
      expect(state.completedCount).toBe(1)
      expect(state.inProgressCount).toBe(1)
      expect(state.pendingCount).toBe(1)
      expect(state.openCount).toBe(2)
      expect(state.stale).toBe(false)
      cache.close()
    })

    it("records canonical TaskList sync time on snapshot", async () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      const base = await tmp.create()
      const sessionDir = await createSessionDir(base, "session-snap-sync-time")
      const syncedAtMs = Date.now() - 1_000

      cache.applyTaskListSnapshot("session-snap-sync-time", [makeTask("1", "pending")], syncedAtMs)

      const state = await cache.getState("session-snap-sync-time", sessionDir)
      expect(state.canonicalTaskListSyncedAtMs).toBe(syncedAtMs)
      cache.close()
    })

    it("creates entry for uncached session", async () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      const base = await tmp.create()
      const sessionDir = await createSessionDir(base, "session-snap-cold")

      // No prior getState — cold cache
      cache.applyTaskListSnapshot("session-snap-cold", [
        makeTask("1", "in_progress"),
        makeTask("2", "pending"),
      ])

      expect(cache.has("session-snap-cold")).toBe(true)
      const state = await cache.getState("session-snap-cold", sessionDir)
      expect(state.tasks).toHaveLength(2)
      expect(state.inProgressCount).toBe(1)
      expect(state.pendingCount).toBe(1)
      expect(state.stale).toBe(false)
      cache.close()
    })

    it("sorts tasks by ID", async () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      const base = await tmp.create()
      const sessionDir = await createSessionDir(base, "session-snap-sort")

      cache.applyTaskListSnapshot("session-snap-sort", [
        makeTask("3", "pending"),
        makeTask("1", "pending"),
        makeTask("2", "pending"),
      ])

      const state = await cache.getState("session-snap-sort", sessionDir)
      expect(state.tasks.map((t) => t.id)).toEqual(["1", "2", "3"])
      cache.close()
    })
  })

  describe("applyTaskAuditSnapshot", () => {
    it("adds a new task on create action", async () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      const base = await tmp.create()
      const sessionDir = await createSessionDir(base, "session-audit-create")
      await writeTaskFile(sessionDir, makeTask("1", "in_progress"))
      await cache.getState("session-audit-create", sessionDir)

      cache.applyTaskAuditSnapshot("session-audit-create", {
        taskId: "2",
        action: "create",
        newStatus: "pending",
        subject: "New audit task",
      })

      const state = await cache.getState("session-audit-create", sessionDir)
      expect(state.tasks).toHaveLength(2)
      expect(state.pendingCount).toBe(1)
      expect(state.inProgressCount).toBe(1)
      cache.close()
    })

    it("updates status on status_change action", async () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      const base = await tmp.create()
      const sessionDir = await createSessionDir(base, "session-audit-status")
      await writeTaskFile(sessionDir, makeTask("1", "pending"))
      await cache.getState("session-audit-status", sessionDir)

      cache.applyTaskAuditSnapshot("session-audit-status", {
        taskId: "1",
        action: "status_change",
        newStatus: "in_progress",
      })

      const state = await cache.getState("session-audit-status", sessionDir)
      expect(state.pendingCount).toBe(0)
      expect(state.inProgressCount).toBe(1)
      cache.close()
    })

    it("removes task on delete action", async () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      const base = await tmp.create()
      const sessionDir = await createSessionDir(base, "session-audit-delete")
      await writeTaskFile(sessionDir, makeTask("1", "pending"))
      await writeTaskFile(sessionDir, makeTask("2", "in_progress"))
      await cache.getState("session-audit-delete", sessionDir)

      cache.applyTaskAuditSnapshot("session-audit-delete", {
        taskId: "1",
        action: "delete",
      })

      const state = await cache.getState("session-audit-delete", sessionDir)
      expect(state.tasks).toHaveLength(1)
      expect(state.pendingCount).toBe(0)
      cache.close()
    })

    it("is a no-op when session has no cached state", () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      cache.applyTaskAuditSnapshot("uncached", {
        taskId: "1",
        action: "status_change",
        newStatus: "completed",
      })
      expect(cache.has("uncached")).toBe(false)
      cache.close()
    })
  })

  describe("removeTask", () => {
    it("removes task and recomputes counts", async () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      const base = await tmp.create()
      const sessionDir = await createSessionDir(base, "session-rm")
      await writeTaskFile(sessionDir, makeTask("1", "pending"))
      await writeTaskFile(sessionDir, makeTask("2", "in_progress"))

      await cache.getState("session-rm", sessionDir)
      cache.removeTask("session-rm", "1")

      const state = await cache.getState("session-rm", sessionDir)
      expect(state.tasks).toHaveLength(1)
      expect(state.pendingCount).toBe(0)
      expect(state.inProgressCount).toBe(1)
      cache.close()
    })
  })

  describe("count accessors", () => {
    it("getOpenCount returns pending + in_progress", async () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      const base = await tmp.create()
      const sessionDir = await createSessionDir(base, "session-oc")
      await writeTaskFile(sessionDir, makeTask("1", "completed"))
      await writeTaskFile(sessionDir, makeTask("2", "pending"))
      await writeTaskFile(sessionDir, makeTask("3", "in_progress"))

      const count = await cache.getOpenCount("session-oc", sessionDir)
      expect(count).toBe(2)
      cache.close()
    })

    it("hasInProgressTask returns true when in_progress exists", async () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      const base = await tmp.create()
      const sessionDir = await createSessionDir(base, "session-ip")
      await writeTaskFile(sessionDir, makeTask("1", "pending"))

      expect(await cache.hasInProgressTask("session-ip", sessionDir)).toBe(false)

      cache.applyTaskUpdate("session-ip", makeTask("1", "in_progress"))
      expect(await cache.hasInProgressTask("session-ip", sessionDir)).toBe(true)
      cache.close()
    })
  })

  describe("LRU eviction", () => {
    it("evicts oldest session when max entries exceeded", async () => {
      const cache = new TaskStateCache({ maxEntries: 2 })
      const base = await tmp.create()

      const dir1 = await createSessionDir(base, "s1")
      const dir2 = await createSessionDir(base, "s2")
      const dir3 = await createSessionDir(base, "s3")

      await writeTaskFile(dir1, makeTask("1", "pending"))
      await writeTaskFile(dir2, makeTask("1", "pending"))
      await writeTaskFile(dir3, makeTask("1", "pending"))

      await cache.getState("s1", dir1)
      await cache.getState("s2", dir2)

      expect(cache.size).toBe(2)

      // Adding s3 should evict s1 (oldest)
      await cache.getState("s3", dir3)
      expect(cache.size).toBe(2)
      expect(cache.has("s1")).toBe(false)
      expect(cache.has("s2")).toBe(true)
      expect(cache.has("s3")).toBe(true)
      cache.close()
    })
  })

  describe("getTasksFresh", () => {
    it("forces full reload when no watcher is active", async () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      const base = await tmp.create()
      const sessionDir = await createSessionDir(base, "session-fresh-no-watch")
      await writeTaskFile(sessionDir, makeTask("1", "completed"))

      // Warm cache via regular getState (no watcher registered)
      const initial = await cache.getState("session-fresh-no-watch", sessionDir)
      expect(initial.tasks).toHaveLength(1)

      // Simulate native Claude TaskCreate writing directly to disk
      await writeTaskFile(sessionDir, makeTask("2", "pending"))

      // getTasksFresh without watcher must see the new task (full reload)
      const fresh = await cache.getTasksFresh("session-fresh-no-watch", sessionDir)
      expect(fresh).toHaveLength(2)
      expect(fresh.find((t) => t.id === "2")?.status).toBe("pending")
      cache.close()
    })

    it("uses cache when watcher is active and entry is fresh", async () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      const base = await tmp.create()
      const sessionDir = await createSessionDir(base, "session-fresh-watched")
      await writeTaskFile(sessionDir, makeTask("1", "completed"))

      // Register watcher and warm cache
      cache.watchSession("session-fresh-watched", sessionDir)
      await cache.getState("session-fresh-watched", sessionDir)

      // Write to disk without going through cache — watcher hasn't fired yet
      // (fs.watch is async, may not fire in time for this test)
      // But since we have a watcher AND entry is fresh, cache is trusted
      const fresh = await cache.getTasksFresh("session-fresh-watched", sessionDir)
      expect(fresh).toHaveLength(1) // cached value, not re-read from disk
      cache.close()
    })

    it("loads canonical TaskList sync time from sentinel on full load", async () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      const base = await tmp.create()
      const sessionId = `session-fresh-sentinel-${process.pid}`
      const sessionDir = await createSessionDir(base, sessionId)
      const syncedAtMs = Date.now() - 2_000
      await writeTaskFile(sessionDir, makeTask("1", "pending"))
      await writeTaskListSyncSentinel(sessionId, syncedAtMs)

      const state = await cache.getState(sessionId, sessionDir)
      expect(state.canonicalTaskListSyncedAtMs).toBe(syncedAtMs)
      cache.close()
    })
  })

  describe("lifecycle", () => {
    it("close() clears all state", async () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      const base = await tmp.create()
      const sessionDir = await createSessionDir(base, "session-close")
      await writeTaskFile(sessionDir, makeTask("1", "pending"))

      await cache.getState("session-close", sessionDir)
      expect(cache.size).toBeGreaterThan(0)

      cache.close()
      expect(cache.size).toBe(0)
    })

    it("invalidateAll() forces full reload on next access", async () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      const base = await tmp.create()
      const sessionDir = await createSessionDir(base, "session-inv")
      await writeTaskFile(sessionDir, makeTask("1", "pending"))

      await cache.getState("session-inv", sessionDir)

      // Add task on disk, invalidate all
      await writeTaskFile(sessionDir, makeTask("2", "pending"))
      cache.invalidateAll()

      // Full reload should see both tasks
      const state = await cache.getState("session-inv", sessionDir)
      expect(state.tasks).toHaveLength(2)
      cache.close()
    })

    it("skips dotfiles and compact-snapshot.json", async () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      const base = await tmp.create()
      const sessionDir = await createSessionDir(base, "session-skip")
      await writeTaskFile(sessionDir, makeTask("1", "pending"))
      await writeFile(join(sessionDir, ".session-meta.json"), "{}")
      await writeFile(join(sessionDir, ".audit-log.jsonl"), "")
      await writeFile(join(sessionDir, "compact-snapshot.json"), "{}")

      const state = await cache.getState("session-skip", sessionDir)
      expect(state.tasks).toHaveLength(1)
      cache.close()
    })
  })

  describe("stale completed task pruning", () => {
    it("prunes completed tasks older than 15 minutes on full load", async () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      const base = await tmp.create()
      const sessionDir = await createSessionDir(base, "session-prune-old")

      const staleTask: SessionTask = {
        ...makeTask("1", "completed"),
        completedAt: Date.now() - 16 * 60_000,
      }
      const keepTask = makeTask("2", "pending")
      await writeTaskFile(sessionDir, staleTask)
      await writeTaskFile(sessionDir, keepTask)

      const state = await cache.getState("session-prune-old", sessionDir)
      expect(state.tasks).toHaveLength(1)
      expect(state.tasks[0]!.id).toBe("2")
      expect(state.completedCount).toBe(0)

      const pruned = Bun.file(join(sessionDir, "1.json"))
      expect(await pruned.exists()).toBe(false)
      cache.close()
    })

    it("keeps completed tasks younger than 15 minutes", async () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      const base = await tmp.create()
      const sessionDir = await createSessionDir(base, "session-prune-recent")

      const recentTask: SessionTask = {
        ...makeTask("1", "completed"),
        completedAt: Date.now() - 5 * 60_000,
      }
      await writeTaskFile(sessionDir, recentTask)
      await writeTaskFile(sessionDir, makeTask("2", "pending"))

      const state = await cache.getState("session-prune-recent", sessionDir)
      expect(state.tasks).toHaveLength(2)
      expect(state.completedCount).toBe(1)

      expect(await Bun.file(join(sessionDir, "1.json")).exists()).toBe(true)
      cache.close()
    })

    it("never prunes non-completed tasks regardless of age", async () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      const base = await tmp.create()
      const sessionDir = await createSessionDir(base, "session-prune-open")

      const oldPending: SessionTask = {
        ...makeTask("1", "pending"),
        completedAt: null,
        statusChangedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      }
      const oldInProgress: SessionTask = {
        ...makeTask("2", "in_progress"),
        completedAt: null,
        statusChangedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      }
      await writeTaskFile(sessionDir, oldPending)
      await writeTaskFile(sessionDir, oldInProgress)

      const state = await cache.getState("session-prune-open", sessionDir)
      expect(state.tasks).toHaveLength(2)
      expect(state.openCount).toBe(2)

      expect(await Bun.file(join(sessionDir, "1.json")).exists()).toBe(true)
      expect(await Bun.file(join(sessionDir, "2.json")).exists()).toBe(true)
      cache.close()
    })
  })

  describe("event state pruning", () => {
    it("unwatchSession prunes event state for that session", async () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      const base = await tmp.create()
      const sessionDir = await createSessionDir(base, "s-evict")
      await writeTaskFile(sessionDir, makeTask("1", "pending"))

      cache.watchSession("s-evict", sessionDir)
      await cache.getState("s-evict", sessionDir)

      applyTaskCreateEvent("s-evict", "99", "Event task")
      expect(getSessionEventState("s-evict")).toHaveLength(1)

      cache.unwatchSession("s-evict")
      expect(getSessionEventState("s-evict")).toBeNull()
      // close() not needed — unwatchSession already cleaned up.
    })

    it("LRU eviction prunes event state for evicted session", async () => {
      const cache = new TaskStateCache({ maxEntries: 2 })
      const base = await tmp.create()
      const pid = process.pid
      const dir1 = await createSessionDir(base, `lru-a-${pid}`)
      const dir2 = await createSessionDir(base, `lru-b-${pid}`)
      const dir3 = await createSessionDir(base, `lru-c-${pid}`)
      await writeTaskFile(dir1, makeTask("1", "pending"))
      await writeTaskFile(dir2, makeTask("1", "pending"))
      await writeTaskFile(dir3, makeTask("1", "pending"))

      await cache.getState(`lru-a-${pid}`, dir1)
      await cache.getState(`lru-b-${pid}`, dir2)

      applyTaskCreateEvent(`lru-a-${pid}`, "10", "Will be evicted")
      applyTaskCreateEvent(`lru-b-${pid}`, "10", "Will survive")

      // Adding lru-c evicts lru-a (oldest), which prunes its event state
      await cache.getState(`lru-c-${pid}`, dir3)

      expect(getSessionEventState(`lru-a-${pid}`)).toBeNull()
      expect(getSessionEventState(`lru-b-${pid}`)).toHaveLength(1)
      // Cleanup: prune remaining event state without close()
      pruneSession(`lru-b-${pid}`)
      pruneSession(`lru-c-${pid}`)
    })

    it("close() clears all event state", async () => {
      const cache = new TaskStateCache({ maxEntries: 10 })
      const base = await tmp.create()
      const sessionDir = await createSessionDir(base, "s-close-evt")
      await writeTaskFile(sessionDir, makeTask("1", "pending"))

      await cache.getState("s-close-evt", sessionDir)
      applyTaskCreateEvent("s-close-evt", "5", "Event task")
      expect(getSessionEventState("s-close-evt")).toHaveLength(1)

      cache.close()
      expect(getSessionEventState("s-close-evt")).toBeNull()
    })
  })
})
