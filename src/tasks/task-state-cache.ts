/**
 * In-memory task state cache with fs.watch invalidation.
 *
 * Provides O(1) reads for session task state after the initial load.
 * Two update channels keep it fresh:
 *
 *   1. **fs.watch** — catches Claude's native TaskCreate/TaskUpdate writes
 *      that bypass swiz. On change, only the 3 most recently modified task
 *      files are re-read and merged into the cached list.
 *
 *   2. **Write-through** — PostToolUse sync hooks call `applyTaskUpdate()`
 *      after disk writes so subsequent hooks in the same dispatch see fresh
 *      data without any disk I/O.
 *
 * Lifecycle: instantiate once in the daemon, call `watchSession()` for each
 * active session, and `close()` on shutdown.
 */

import { type FSWatcher, watch } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { debugLog } from "../debug.ts"
import { computeSubjectFingerprint } from "../subject-fingerprint.ts"
import { taskListSyncSentinelPath } from "../temp-paths.ts"
import { pruneSession, warnInvalidTransition } from "./task-event-state.ts"
import { isSessionTaskJsonFile } from "./task-file-utils.ts"
import type { SessionTask } from "./task-recovery.ts"
import { backfillTaskTimingFields } from "./task-timing.ts"
import { computeTransitionPath, isValidTransition } from "./task-transitions.ts"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SessionTaskState {
  tasks: SessionTask[]
  openCount: number
  pendingCount: number
  inProgressCount: number
  completedCount: number
  /** Epoch ms of the most recent canonical TaskList sync, if known. */
  canonicalTaskListSyncedAtMs: number | null
  /** Epoch ms of the newest task file mtime at last full load. */
  loadedAtMs: number
  /** Wall-clock epoch ms when this entry was last synced from disk. */
  syncedAtMs: number
  /** True when fs.watch has fired since last load — next read must refresh. */
  stale: boolean
}

/** Number of most-recent task files to re-read on incremental refresh. */
const INCREMENTAL_FILE_LIMIT = 3

/** Default max age (ms) for freshness-guaranteed reads. */
const DEFAULT_MAX_STALE_MS = 60_000

/** Canonical TaskList snapshots must be refreshed within 5 minutes. */
export const CANONICAL_TASKLIST_SYNC_MAX_AGE_MS = 5 * 60_000

/** Maximum cached sessions before LRU eviction. */
const MAX_CACHED_SESSIONS = 50

// ─── Helpers ────────────────────────────────────────────────────────────────

export async function readCanonicalTaskListSyncAtMs(sessionId: string): Promise<number | null> {
  if (!sessionId) return null
  try {
    const raw = (await Bun.file(taskListSyncSentinelPath(sessionId)).text()).trim()
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

export async function writeCanonicalTaskListSyncSentinel(
  sessionId: string,
  syncedAtMs = Date.now()
): Promise<number> {
  if (!sessionId) return syncedAtMs
  try {
    await Bun.write(taskListSyncSentinelPath(sessionId), String(syncedAtMs))
  } catch {
    // Best-effort: TaskList sync should still succeed even if the sentinel write fails.
  }
  return syncedAtMs
}

/**
 * Apply timing side-effects for a status transition on a cached task.
 * Mirrors the timing logic in task-service.ts applyStatusTransition
 * without requiring that import (avoids circular deps).
 *
 * - Entering `in_progress`: sets `startedAt`
 * - Leaving `in_progress`: accumulates `elapsedMs`
 * - Entering `completed`: sets `completedAt` and `completionTimestamp`
 * - Always updates `statusChangedAt`
 */
function applyTimingEffects(task: SessionTask, newStatus: string): void {
  const now = Date.now()
  const nowIso = new Date(now).toISOString()

  // Accumulate elapsed time when leaving in_progress
  if (task.status === "in_progress" && task.statusChangedAt) {
    const elapsed = now - new Date(task.statusChangedAt).getTime()
    task.elapsedMs = (task.elapsedMs ?? 0) + Math.max(0, elapsed)
  }

  if (newStatus === "in_progress") task.startedAt = now
  if (newStatus === "completed") {
    task.completedAt = now
    if (!task.completionTimestamp) task.completionTimestamp = nowIso
  }

  task.statusChangedAt = nowIso
}

function computeCounts(tasks: SessionTask[]) {
  let openCount = 0
  let pendingCount = 0
  let inProgressCount = 0
  let completedCount = 0
  for (const t of tasks) {
    if (t.status === "pending") {
      pendingCount++
      openCount++
    } else if (t.status === "in_progress") {
      inProgressCount++
      openCount++
    } else if (t.status === "completed") {
      completedCount++
    }
  }
  return { openCount, pendingCount, inProgressCount, completedCount }
}

async function readTaskFile(filePath: string): Promise<SessionTask | null> {
  try {
    const task = (await Bun.file(filePath).json()) as SessionTask
    if (task.id && task.subject && task.status) {
      if (!task.subjectFingerprint) {
        task.subjectFingerprint = computeSubjectFingerprint(task.subject)
      }
      backfillTaskTimingFields(task)
      return task
    }
  } catch {
    // skip unreadable or malformed
  }
  return null
}

interface FileWithMtime {
  name: string
  mtimeMs: number
}

async function listTaskFiles(dir: string): Promise<FileWithMtime[]> {
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }
  const result: FileWithMtime[] = []
  for (const f of files) {
    if (!isSessionTaskJsonFile(f)) continue
    try {
      const s = await stat(join(dir, f))
      result.push({ name: f, mtimeMs: s.mtimeMs })
    } catch {
      // skip unreadable files
    }
  }
  return result
}

async function loadAllTasks(dir: string): Promise<{ tasks: SessionTask[]; maxMtimeMs: number }> {
  const fileEntries = await listTaskFiles(dir)
  let maxMtimeMs = 0
  const tasks: SessionTask[] = []
  for (const entry of fileEntries) {
    if (entry.mtimeMs > maxMtimeMs) maxMtimeMs = entry.mtimeMs
    const task = await readTaskFile(join(dir, entry.name))
    if (task) tasks.push(task)
  }
  tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { tasks, maxMtimeMs }
}

/**
 * Read only the N most recently modified task files from a directory
 * and merge them into an existing task list. New IDs are appended,
 * existing IDs are replaced.
 */
async function incrementalRefresh(
  dir: string,
  existing: SessionTask[],
  limit: number
): Promise<{ tasks: SessionTask[]; maxMtimeMs: number }> {
  const fileEntries = await listTaskFiles(dir)
  if (fileEntries.length === 0) return { tasks: [], maxMtimeMs: 0 }

  // Sort by mtime descending to pick the N most recent
  fileEntries.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const toRead = fileEntries.slice(0, limit)

  let maxMtimeMs = 0
  const freshById = new Map<string, SessionTask>()
  for (const entry of toRead) {
    if (entry.mtimeMs > maxMtimeMs) maxMtimeMs = entry.mtimeMs
    const task = await readTaskFile(join(dir, entry.name))
    if (task) freshById.set(task.id, task)
  }

  // Also check if any files were deleted (file count decreased)
  const currentFileNames = new Set(fileEntries.map((e) => e.name))

  // Merge: keep existing tasks (unless replaced or deleted), add new ones
  const merged: SessionTask[] = []
  for (const t of existing) {
    const expectedFile = `${t.id}.json`
    if (!currentFileNames.has(expectedFile)) continue // task file was deleted
    const fresh = freshById.get(t.id)
    merged.push(fresh ?? t)
    freshById.delete(t.id)
  }
  // Append genuinely new tasks
  for (const t of freshById.values()) {
    merged.push(t)
  }

  merged.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { tasks: merged, maxMtimeMs }
}

// ─── Cache ──────────────────────────────────────────────────────────────────

export class TaskStateCache {
  private entries = new Map<string, SessionTaskState>()
  private accessOrder: string[] = []
  private watchers = new Map<string, FSWatcher>()
  private tasksDirs = new Map<string, string>()
  private readonly maxEntries: number

  constructor(options?: { maxEntries?: number }) {
    this.maxEntries = options?.maxEntries ?? MAX_CACHED_SESSIONS
  }

  // ─── Watch management ───────────────────────────────────────────────────

  /**
   * Start watching a session's task directory for changes.
   * Call once per active session; safe to call repeatedly (idempotent).
   */
  watchSession(sessionId: string, tasksDir: string): void {
    if (this.watchers.has(sessionId)) return
    this.tasksDirs.set(sessionId, tasksDir)
    try {
      const watcher = watch(tasksDir, { recursive: false }, () => {
        this.markStale(sessionId)
      })
      this.watchers.set(sessionId, watcher)
    } catch {
      // Directory may not exist yet — that's fine, first read will populate
    }
  }

  /** Stop watching a session and remove its cached state + event state. */
  unwatchSession(sessionId: string): void {
    const watcher = this.watchers.get(sessionId)
    if (watcher) {
      watcher.close()
      this.watchers.delete(sessionId)
    }
    this.entries.delete(sessionId)
    this.tasksDirs.delete(sessionId)
    this.accessOrder = this.accessOrder.filter((id) => id !== sessionId)
    pruneSession(sessionId)
  }

  /** Mark a session's cache entry as stale (fs.watch callback). */
  private markStale(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (entry) entry.stale = true
  }

  // ─── Read API ───────────────────────────────────────────────────────────

  /**
   * Get tasks for a session. Returns cached data when fresh, otherwise
   * performs a disk read (full on first access, incremental on invalidation).
   */
  async getTasks(sessionId: string, tasksDir: string): Promise<SessionTask[]> {
    const state = await this.getState(sessionId, tasksDir)
    return state.tasks
  }

  /**
   * Get the full state object (tasks + counts). Callers that only need
   * counts should use the count accessors below for clarity.
   */
  async getState(sessionId: string, tasksDir: string): Promise<SessionTaskState> {
    const existing = this.entries.get(sessionId)

    // Cache hit — fresh, but zero incomplete tasks is a logical gap: the task
    // governance system enforces ≥2 incomplete at all times, so an empty count
    // means native writes were missed. Force a full reload to re-sync.
    if (existing && !existing.stale && existing.openCount > 0) {
      this.touchAccessOrder(sessionId)
      return existing
    }

    // Cache hit — stale (incremental refresh: read only 3 most recent files)
    if (existing?.stale) {
      const { tasks, maxMtimeMs } = await incrementalRefresh(
        tasksDir,
        existing.tasks,
        INCREMENTAL_FILE_LIMIT
      )
      const counts = computeCounts(tasks)
      const now = Date.now()
      const state: SessionTaskState = {
        tasks,
        ...counts,
        canonicalTaskListSyncedAtMs: await readCanonicalTaskListSyncAtMs(sessionId),
        loadedAtMs: maxMtimeMs,
        syncedAtMs: now,
        stale: false,
      }
      this.entries.set(sessionId, state)
      this.touchAccessOrder(sessionId)
      return state
    }

    // Cache miss — full load
    return this.fullLoad(sessionId, tasksDir)
  }

  /**
   * Get tasks with a freshness guarantee. Forces a full disk reload when:
   * - No cached entry exists
   * - The entry is marked stale (fs.watch fired)
   * - The entry is older than `maxStaleMs`
   * - No fs.watch watcher is active for this session (native Claude writes
   *   bypass the write-through path, so the cache may be incomplete)
   *
   * Use in stop hooks where accuracy is critical.
   */
  async getTasksFresh(
    sessionId: string,
    tasksDir: string,
    maxStaleMs = DEFAULT_MAX_STALE_MS
  ): Promise<SessionTask[]> {
    const existing = this.entries.get(sessionId)
    const hasWatcher = this.watchers.has(sessionId)
    // Zero cached tasks is always suspect — native TaskCreate may have written
    // directly to disk. Force a full reload to ensure nothing is missed.
    const isEmpty = existing ? existing.tasks.length === 0 : true
    if (
      existing &&
      !existing.stale &&
      !isEmpty &&
      hasWatcher &&
      Date.now() - existing.syncedAtMs <= maxStaleMs
    ) {
      this.touchAccessOrder(sessionId)
      return existing.tasks
    }
    // No entry, stale, no watcher, or too old ��� full disk reload
    const state = await this.fullLoad(sessionId, tasksDir)
    return state.tasks
  }

  /** O(1) count of incomplete tasks (pending + in_progress). */
  async getOpenCount(sessionId: string, tasksDir: string): Promise<number> {
    return (await this.getState(sessionId, tasksDir)).openCount
  }

  /** O(1) check for whether any task is in_progress. */
  async hasInProgressTask(sessionId: string, tasksDir: string): Promise<boolean> {
    return (await this.getState(sessionId, tasksDir)).inProgressCount > 0
  }

  // ─── Write-through API ──────────────────────────────────────────────────

  /**
   * Apply an in-memory task update without disk I/O. Call this from
   * PostToolUse sync hooks after they've written to disk, so subsequent
   * hooks in the same dispatch chain see the update immediately.
   */
  applyTaskUpdate(sessionId: string, task: SessionTask): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return // no cached state to update

    const idx = entry.tasks.findIndex((t) => t.id === task.id)
    if (idx >= 0) {
      const existing = entry.tasks[idx]!
      if (existing.status !== task.status) {
        if (!isValidTransition(existing.status, task.status)) {
          // Auto-transition through intermediate states for timing effects
          const path = computeTransitionPath(existing.status, task.status)
          if (path && path.length > 1) {
            debugLog(
              `[task-transition] cache-update: auto-transitioning task #${task.id} ` +
                `${existing.status} → ${path.join(" → ")} (session ${sessionId.slice(0, 8)}…)`
            )
            for (const step of path.slice(0, -1)) {
              applyTimingEffects(existing, step)
              existing.status = step
            }
          } else {
            warnInvalidTransition("cache-update", sessionId, task.id, existing.status, task.status)
          }
        }
        // Apply timing for the final target status before replacing
        applyTimingEffects(existing, task.status)
      }
      // Replace with the incoming task but preserve timing from intermediate steps
      const merged = { ...task }
      if (existing.status !== task.status) {
        // Incoming task has the final status; keep accumulated timing from intermediates
        merged.elapsedMs = existing.elapsedMs
        merged.startedAt = existing.startedAt
        merged.statusChangedAt = existing.statusChangedAt
      }
      entry.tasks[idx] = merged
    } else {
      entry.tasks.push(task)
      entry.tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }

    // Recompute counts
    const counts = computeCounts(entry.tasks)
    entry.openCount = counts.openCount
    entry.pendingCount = counts.pendingCount
    entry.inProgressCount = counts.inProgressCount
    entry.completedCount = counts.completedCount
    // Mark as fresh since we just applied the latest known state
    entry.stale = false
  }

  /**
   * Replace the entire cached task list for a session from a TaskList response.
   * Recomputes counts and marks the entry as fresh. Creates a new entry if
   * none exists yet (unlike applyTaskUpdate which is a no-op on cold cache).
   *
   * When a cached entry exists, walks each task through valid intermediate
   * transitions so timing effects are tracked incrementally rather than
   * clobbered. Falls back to wholesale replacement when no prior state exists.
   */
  applyTaskListSnapshot(
    sessionId: string,
    tasks: SessionTask[],
    canonicalTaskListSyncedAtMs: number | null = Date.now()
  ): void {
    const sorted = [...tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const now = Date.now()
    const existing = this.entries.get(sessionId)

    // When prior state exists, reconcile each task's status incrementally
    if (existing && existing.tasks.length > 0) {
      const oldById = new Map(existing.tasks.map((t) => [t.id, t]))
      for (const incoming of sorted) {
        const old = oldById.get(incoming.id)
        if (!old || old.status === incoming.status) continue
        if (!isValidTransition(old.status, incoming.status)) {
          const path = computeTransitionPath(old.status, incoming.status)
          if (path && path.length > 1) {
            debugLog(
              `[task-transition] cache-snapshot: auto-transitioning task #${incoming.id} ` +
                `${old.status} → ${path.join(" → ")} (session ${sessionId.slice(0, 8)}…)`
            )
            for (const step of path.slice(0, -1)) {
              applyTimingEffects(old, step)
              old.status = step
            }
          }
        }
        // Apply final timing and carry forward accumulated values
        applyTimingEffects(old, incoming.status)
        incoming.elapsedMs = old.elapsedMs
        incoming.startedAt = old.startedAt
        incoming.statusChangedAt = old.statusChangedAt
      }
    }

    const counts = computeCounts(sorted)
    const state: SessionTaskState = {
      tasks: sorted,
      ...counts,
      canonicalTaskListSyncedAtMs,
      loadedAtMs: existing?.loadedAtMs ?? now,
      syncedAtMs: now,
      stale: false,
    }
    this.entries.set(sessionId, state)
    this.touchAccessOrder(sessionId)
    this.evictIfNeeded()
  }

  /**
   * Apply an audit entry's mutation to the cached session state.
   * Handles create (adds a stub task), status_change (updates status),
   * and delete (removes task). No-op when no cached entry exists.
   */
  applyTaskAuditSnapshot(
    sessionId: string,
    entry: { taskId: string; action: string; newStatus?: string; subject?: string }
  ): void {
    const cached = this.entries.get(sessionId)
    if (!cached) return

    if (entry.action === "create" && entry.subject) {
      const exists = cached.tasks.some((t) => t.id === entry.taskId)
      if (!exists) {
        const stub: SessionTask = {
          id: entry.taskId,
          subject: entry.subject,
          status: entry.newStatus ?? "pending",
          statusChangedAt: new Date().toISOString(),
          elapsedMs: 0,
          startedAt: entry.newStatus === "in_progress" ? Date.now() : null,
          completedAt: null,
        }
        cached.tasks.push(stub)
        cached.tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      }
    } else if (entry.action === "status_change" && entry.newStatus) {
      const task = cached.tasks.find((t) => t.id === entry.taskId)
      if (task) {
        if (!isValidTransition(task.status, entry.newStatus)) {
          // Auto-transition through valid intermediate states so timing
          // effects (elapsedMs, startedAt, completedAt) are tracked at each step.
          const path = computeTransitionPath(task.status, entry.newStatus)
          if (path && path.length > 1) {
            debugLog(
              `[task-transition] cache-audit: auto-transitioning task #${entry.taskId} ` +
                `${task.status} → ${path.join(" → ")} (session ${sessionId.slice(0, 8)}…)`
            )
            for (const step of path) {
              applyTimingEffects(task, step)
              task.status = step
            }
          } else {
            warnInvalidTransition(
              "cache-audit",
              sessionId,
              entry.taskId,
              task.status,
              entry.newStatus
            )
            applyTimingEffects(task, entry.newStatus)
            task.status = entry.newStatus
          }
        } else {
          applyTimingEffects(task, entry.newStatus)
          task.status = entry.newStatus
        }
      }
    } else if (entry.action === "delete") {
      cached.tasks = cached.tasks.filter((t) => t.id !== entry.taskId)
    }

    const counts = computeCounts(cached.tasks)
    cached.openCount = counts.openCount
    cached.pendingCount = counts.pendingCount
    cached.inProgressCount = counts.inProgressCount
    cached.completedCount = counts.completedCount
    cached.stale = false
  }

  /**
   * Remove a task from the cached state (e.g. after file deletion).
   */
  removeTask(sessionId: string, taskId: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    entry.tasks = entry.tasks.filter((t) => t.id !== taskId)
    const counts = computeCounts(entry.tasks)
    entry.openCount = counts.openCount
    entry.pendingCount = counts.pendingCount
    entry.inProgressCount = counts.inProgressCount
    entry.completedCount = counts.completedCount
  }

  // ─── Cache state inspection ─────────────────────────────────────────────

  /** Whether we have a cached entry for this session (stale or fresh). */
  has(sessionId: string): boolean {
    return this.entries.has(sessionId)
  }

  /** Whether the cached entry is marked stale. */
  isStale(sessionId: string): boolean {
    return this.entries.get(sessionId)?.stale ?? false
  }

  /** Number of cached session entries. */
  get size(): number {
    return this.entries.size
  }

  /** Snapshot of all watched session IDs. */
  watchedSessions(): string[] {
    return [...this.watchers.keys()]
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /** Close all watchers and clear both the cache and in-memory event state. */
  close(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close()
    }
    this.watchers.clear()
    // Prune event state only for sessions this cache tracked — avoids
    // clearing state owned by other cache instances in concurrent tests.
    for (const sessionId of this.entries.keys()) {
      pruneSession(sessionId)
    }
    for (const sessionId of this.tasksDirs.keys()) {
      pruneSession(sessionId)
    }
    this.entries.clear()
    this.tasksDirs.clear()
    this.accessOrder = []
  }

  /** Invalidate a single session entry (force full reload on next read). */
  invalidate(sessionId: string): void {
    this.entries.delete(sessionId)
  }

  /** Invalidate all entries. */
  invalidateAll(): void {
    this.entries.clear()
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  /** Full disk reload — used on cold miss and freshness-guaranteed reads. */
  private async fullLoad(sessionId: string, tasksDir: string): Promise<SessionTaskState> {
    const { tasks, maxMtimeMs } = await loadAllTasks(tasksDir)
    const counts = computeCounts(tasks)
    const now = Date.now()
    const state: SessionTaskState = {
      tasks,
      ...counts,
      canonicalTaskListSyncedAtMs: await readCanonicalTaskListSyncAtMs(sessionId),
      loadedAtMs: maxMtimeMs,
      syncedAtMs: now,
      stale: false,
    }
    this.entries.set(sessionId, state)
    this.tasksDirs.set(sessionId, tasksDir)
    this.touchAccessOrder(sessionId)
    this.evictIfNeeded()
    return state
  }

  private touchAccessOrder(sessionId: string): void {
    const idx = this.accessOrder.indexOf(sessionId)
    if (idx >= 0) this.accessOrder.splice(idx, 1)
    this.accessOrder.push(sessionId)
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries && this.accessOrder.length > 0) {
      const oldest = this.accessOrder.shift()!
      this.unwatchSession(oldest)
    }
  }
}
