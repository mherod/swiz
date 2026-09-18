/**
 * Task persistence layer — file I/O for task and audit records.
 * Owns: Task/AuditEntry types, readTasks, writeTask, writeAudit,
 *       ID utilities (parseTaskId, compareTaskIds), and STATUS_STYLE.
 */

import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { debugLog } from "../debug.ts"
import { legacySessionPrefix, sessionPrefix } from "../session-id.ts"
import { createDefaultTaskStore } from "../task-roots.ts"
import { CappedMap } from "../utils/capped-map.ts"
import { appendJsonlEntry, parseJsonl } from "../utils/jsonl.ts"
import { isSessionTaskJsonFile } from "./task-file-utils.ts"
import {
  prepareTaskStoreWrite,
  readTaskStorePath,
  resolveLegacyTaskStoreKey,
} from "./task-store-layout.ts"
import {
  isSafeSessionId,
  projectStoreKey,
  sessionDirPath,
  sessionStoreKey,
  type TaskStoreKey,
  taskStoreDirName,
} from "./task-store-path.ts"

export { resolveLegacyTaskStoreKey } from "./task-store-layout.ts"

import { backfillTaskTimingFields } from "./task-timing.ts"

const AUDIT_LOG_FILENAME = ".audit-log.jsonl"

export { legacySessionPrefix, sessionPrefix }

// ─── Session directory containment ──────────────────────────────────────────
// Defined in `task-store-path.ts` so callers that this module imports can share it; re-exported
// here because most consumers already reach the guard through the repository. The import above
// is what binds it for this module's own calls — `export … from` alone re-exports without
// introducing a local binding, which leaves readTasks throwing "isSafeSessionId is not defined".

export {
  isSafeSessionId,
  projectStoreKey,
  sessionDirPath,
  sessionStoreKey,
  taskStoreDirName,
  type TaskStoreKey,
}

// ─── Types ──────────────────────────────────────────────────────────────────

export const TASK_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const
export const taskStatusSchema = z.enum(TASK_STATUSES)
export type TaskStatus = z.infer<typeof taskStatusSchema>

export interface Task {
  id: string
  subject: string
  description: string
  activeForm?: string
  status: TaskStatus
  blocks: string[]
  blockedBy: string[]
  completionEvidence?: string
  completionTimestamp?: string
  /** Epoch milliseconds when the task most recently entered in_progress. */
  startedAt?: number | null
  /** Epoch milliseconds when the task most recently entered completed. */
  completedAt?: number | null
  /** ISO timestamp of last status change (used for elapsed-time tracking) */
  statusChangedAt?: string
  /**
   * ISO timestamp of the last persisted write of any kind. Unlike
   * `statusChangedAt`, a description-only update refreshes this, so recency
   * gates can be satisfied without forcing a status transition.
   */
  updatedAt?: string
  /** Cumulative milliseconds spent in in_progress status */
  elapsedMs?: number
  /** Deterministic fingerprint of the normalized subject for deduplication. */
  subjectFingerprint?: string
}

/** Whether a task status represents an incomplete (actionable) task. */
export function isIncompleteTaskStatus(status: string): boolean {
  const parsed = taskStatusSchema.safeParse(status)
  return parsed.success && (parsed.data === "pending" || parsed.data === "in_progress")
}

export type TaskMutationAction = "create" | "status_change" | "delete" | "field_update"

export interface AuditEntry {
  timestamp: string
  taskId: string
  action: TaskMutationAction
  oldStatus?: TaskStatus
  newStatus?: TaskStatus
  verificationText?: string
  evidence?: string
  subject?: string
  /** Stable operation key used to make a retried batch's audit append idempotent. */
  operationId?: string
}

export const STATUS_STYLE: Record<TaskStatus, { emoji: string; color: string }> = {
  pending: { emoji: "⏳", color: "\x1b[33m" },
  in_progress: { emoji: "🔄", color: "\x1b[36m" },
  completed: { emoji: "✅", color: "\x1b[32m" },
  cancelled: { emoji: "❌", color: "\x1b[31m" },
}

// ─── Task ID utilities ───────────────────────────────────────────────────────

/**
 * Parse a potentially prefixed task ID into its components.
 * - "a3f2-5" → { prefix: "a3f2", seq: 5 }
 * - "5" → { prefix: null, seq: 5 }
 * - "a3f2-abc" → { prefix: "a3f2", seq: NaN } (invalid)
 */
export function parseTaskId(taskId: string): { prefix: string | null; seq: number } {
  const dashIdx = taskId.indexOf("-")
  if (dashIdx > 0) {
    const prefix = taskId.slice(0, dashIdx)
    const seq = parseInt(taskId.slice(dashIdx + 1), 10)
    return { prefix, seq }
  }
  return { prefix: null, seq: parseInt(taskId, 10) }
}

/**
 * Sort comparator for task IDs that handles both numeric and prefixed formats.
 * Prefixed IDs sort after numeric IDs; within the same prefix, sort by sequence.
 */
export function compareTaskIds(a: string, b: string): number {
  const pa = parseTaskId(a)
  const pb = parseTaskId(b)
  // Both numeric — sort numerically
  if (pa.prefix === null && pb.prefix === null) return pa.seq - pb.seq
  // Numeric before prefixed
  if (pa.prefix === null) return -1
  if (pb.prefix === null) return 1
  // Both prefixed — sort by prefix then sequence
  if (pa.prefix !== pb.prefix) return pa.prefix.localeCompare(pb.prefix)
  return pa.seq - pb.seq
}

// ─── Audit-log recovery ─────────────────────────────────────────────────────

/**
 * Attempt to reconstruct a task from the audit log when its JSON file is
 * unreadable (corrupt, partially written, etc.). Scans all audit entries
 * for the given taskId and rebuilds the task from the most recent state.
 * Returns null if the audit log has no entries for this task.
 */
async function recoverTaskFromAuditLog(dir: string, taskId: string): Promise<Task | null> {
  try {
    const logPath = join(dir, AUDIT_LOG_FILENAME)
    const text = await readFile(logPath, "utf-8")
    const lines = text.trim().split("\n").filter(Boolean)

    let lastStatus: Task["status"] = "pending"
    let lastSubject = ""
    let found = false

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as AuditEntry
        if (entry.taskId !== taskId) continue
        found = true
        if (entry.newStatus) lastStatus = entry.newStatus
        if (entry.subject) lastSubject = entry.subject
      } catch {
        // skip malformed audit lines
      }
    }

    if (!found) return null

    return {
      id: taskId,
      subject: lastSubject || `Recovered task ${taskId}`,
      description: `Recovered from audit log — original task file was unreadable.`,
      status: lastStatus,
      blocks: [],
      blockedBy: [],
    }
  } catch {
    return null
  }
}

// ─── Atomic file write ──────────────────────────────────────────────────────

/**
 * Write JSON to `filePath` atomically: write to a sibling temp file then
 * `rename()` it into place. POSIX rename is atomic, so concurrent readers
 * (Bun.file().json(), readSessionTasks, fs.watch-driven cache refresh) never
 * observe a partial or truncated file. Eliminates the window where an
 * in-progress JSON.stringify lands halfway and silently drops the task
 * from cache reads.
 */
export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 10)}.tmp`
  await writeFile(tempPath, JSON.stringify(data, null, 2))
  try {
    await rename(tempPath, filePath)
  } catch (err) {
    try {
      await rm(tempPath, { force: true })
    } catch {
      // best-effort cleanup
    }
    throw err
  }
}

// ─── Task I/O ────────────────────────────────────────────────────────────────

export async function readTasks(
  sessionId: string,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<Task[]> {
  return readTaskStore(await resolveLegacyTaskStoreKey(sessionId, undefined, tasksDir), tasksDir)
}

async function readTasksInDirectory(dir: string): Promise<Task[]> {
  // Junie fallback: if events.jsonl exists, parse tasks from AgentPlanUpdatedEvent
  const eventsPath = join(dir, "events.jsonl")
  try {
    const text = await readFile(eventsPath, "utf-8")
    const schema = z.looseObject({
      kind: z.string(),
      event: z.looseObject({
        agentEvent: z.looseObject({
          kind: z.string(),
          items: z
            .array(
              z.looseObject({
                status: z.string(),
                description: z.string(),
              })
            )
            .optional(),
        }),
      }),
    })
    const entries = parseJsonl(text, schema)
    const planEvents = entries.filter((e) => e.event?.agentEvent?.kind === "AgentPlanUpdatedEvent")
    if (planEvents.length > 0) {
      const lastPlan = planEvents[planEvents.length - 1]!.event!.agentEvent!.items!
      return lastPlan.map((item, i) => {
        const statusMap: Record<string, Task["status"]> = {
          IN_PROGRESS: "in_progress",
          COMPLETED: "completed",
          PENDING: "pending",
          CANCELLED: "cancelled",
        }
        return {
          id: String(i + 1),
          subject: item.description,
          description: item.description,
          status: statusMap[item.status] || "pending",
          blocks: [],
          blockedBy: [],
        }
      })
    }
  } catch {
    // Fall back to Claude-style tasks if events.jsonl doesn't exist or is invalid
  }

  try {
    const files = await readdir(dir)
    const taskFiles = files.filter(isSessionTaskJsonFile)
    // Read each file independently so a single corrupt or partially-written
    // file (e.g. during a concurrent push event) doesn't nuke the entire list.
    // On failure, attempt recovery from the audit log before discarding.
    const results = await Promise.all(
      taskFiles.map(async (f): Promise<Task | null> => {
        try {
          const filePath = join(dir, f)
          const task = JSON.parse(await readFile(filePath, "utf-8")) as Task
          if (!task.id || !task.subject || !taskStatusSchema.safeParse(task.status).success)
            return null
          task.description ??= ""
          task.blocks ??= []
          task.blockedBy ??= []
          const st = await stat(filePath)
          // Backfill timing fields for legacy tasks that predate explicit timestamps.
          if (!task.statusChangedAt) task.statusChangedAt = st.mtime.toISOString()
          // `updatedAt` is deliberately NOT backfilled from mtime. Doing so gave every
          // legacy or externally written record a wall-clock stamp, and because the merge
          // prefers `updatedAt`, two copies written moments apart tied on mtime and the
          // winner became nondeterministic — losing the `statusChangedAt` ordering callers
          // depend on. An absent `updatedAt` correctly falls back to `statusChangedAt`,
          // which is itself mtime-backfilled above.
          backfillTaskTimingFields(task, st.mtimeMs)
          return task
        } catch {
          // Task file unreadable — try to reconstruct from audit log
          const taskId = f.replace(/\.json$/, "")
          return recoverTaskFromAuditLog(dir, taskId)
        }
      })
    )
    const tasks = results.filter((t): t is Task => t !== null)
    return tasks.sort((a, b) => compareTaskIds(a.id, b.id))
  } catch {
    return []
  }
}

/** ISO `statusChangedAt` as epoch ms; 0 when absent or unparseable, so it always loses a compare. */
function statusChangedAtMs(task: { statusChangedAt?: string }): number {
  if (!task.statusChangedAt) return 0
  const parsed = Date.parse(task.statusChangedAt)
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * Last write of any kind as epoch ms, preferring `updatedAt` and falling back to `statusChangedAt`.
 *
 * Tie-breaking on `statusChangedAt` alone loses every field-only update: recording progress in a
 * task's `description` moves `updatedAt` but not `statusChangedAt`, so the refreshed copy tied with
 * the stale one and the duplicate that happened to be seen first kept winning. That made the
 * recency gate in `pretooluse-task-governance` unsatisfiable for any task present in both stores —
 * the remedy it prescribes (record progress) could not change the answer it reads.
 */
function lastWriteMs(task: { updatedAt?: string; statusChangedAt?: string }): number {
  if (task.updatedAt) {
    const parsed = Date.parse(task.updatedAt)
    if (!Number.isNaN(parsed)) return parsed
  }
  return statusChangedAtMs(task)
}

/**
 * Union task lists from several stores, keeping one copy per id — the one written most recently, so
 * a completion or a progress note recorded through either surface wins over a stale duplicate.
 *
 * Generic over the task shape because the daemon's cache serves `SessionTask` while the repository
 * serves `Task`; both carry `id` and the optional ISO stamps, which is all the merge needs.
 */
export function mergeTaskStoresByRecency<
  T extends { id: string; statusChangedAt?: string; updatedAt?: string },
>(...groups: ReadonlyArray<readonly T[]>): T[] {
  const byId = new Map<string, T>()
  for (const group of groups) {
    for (const task of group) {
      const existing = byId.get(task.id)
      if (!existing || lastWriteMs(task) > lastWriteMs(existing)) {
        byId.set(task.id, task)
      }
    }
  }
  return [...byId.values()].sort((a, b) => compareTaskIds(a.id, b.id))
}

/**
 * Read one session's tasks unioned with the project-keyed store for the same machine.
 *
 * The store is keyed by directory name, and two surfaces disagree about what that name means: the
 * MCP server keys by `projectKeyFromCwd(cwd)` while the native task tools key by the agent session
 * id. A reader that consults only one key sees an empty queue for sessions driven by the other —
 * which is how task governance came to block on a queue the agent had already filled (#823).
 *
 * A task present in both stores is returned once, preferring the copy whose status changed most
 * recently, so a completion recorded through either surface wins over a stale duplicate.
 *
 * Pass `projectKey` as undefined to get exactly the single-store behaviour of {@link readTasks}.
 */
export async function readTasksAcrossStores(
  sessionId: string,
  projectKey: string | undefined,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<Task[]> {
  return (await readTaskRecordsAcrossStores(sessionId, projectKey, tasksDir)).map(
    ({ task }) => task
  )
}

/** A task's persistence address travels with it through lookup and mutation. */
export interface StoredTask {
  storeKey: TaskStoreKey
  task: Task
}

/** Explicit single-store reader for native session snapshots and targeted mutations. */
export async function readTaskStore(
  storeKey: TaskStoreKey,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<Task[]> {
  if (!isSafeSessionId(storeKey, tasksDir)) return []
  const dir = await readTaskStorePath(storeKey, tasksDir)
  const tasks = await readTasksInDirectory(dir)
  // A concurrent migration can rename the legacy directory after path resolution.
  // Re-read the destination rather than briefly projecting an empty queue.
  if (storeKey.kind === "project" && dir !== sessionDirPath(storeKey, tasksDir)) {
    const current = await readTaskStorePath(storeKey, tasksDir)
    if (current !== dir) return readTasksInDirectory(current)
  }
  return tasks
}

/**
 * Project queue shared by MCP and hooks. Include positively attributed legacy sessions,
 * plus the explicit current session when it has no ownership metadata yet. Unknown historical
 * directories are not evidence of project ownership. Never use this union for store pruning.
 */
export async function readTaskRecordsAcrossStores(
  sessionId: string | undefined,
  projectKey: string | undefined,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<StoredTask[]> {
  if (!projectKey) {
    if (!sessionId) return []
    const storeKey = await resolveLegacyTaskStoreKey(sessionId, undefined, tasksDir)
    return (await readTaskStore(storeKey, tasksDir)).map((task) => ({ storeKey, task }))
  }
  const keys: TaskStoreKey[] = []
  if (projectKey) keys.push({ kind: "project", key: projectKey })
  for (const id of await sessionCandidates(sessionId, Boolean(projectKey), tasksDir)) {
    if (await sessionBelongsToQueue(id, sessionId, projectKey, tasksDir))
      keys.push(sessionStoreKey(id))
  }
  const groups = await Promise.all(
    keys.map(async (storeKey) =>
      (await readTaskStore(storeKey, tasksDir)).map((task) => ({ ...task, storeKey }))
    )
  )
  return mergeTaskStoresByRecency(...groups).map(({ storeKey, ...task }) => ({ storeKey, task }))
}

async function sessionCandidates(
  sessionId: string | undefined,
  includeHistory: boolean,
  tasksDir: string
) {
  const candidates = new Set<string>(sessionId ? [sessionId] : [])
  if (includeHistory) {
    const entries = await readdir(tasksDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) if (entry.isDirectory()) candidates.add(entry.name)
  }
  return candidates
}

/** Legacy path keys are project addresses, including ones with damaged cwd metadata. */
function isLegacyProjectAddress(
  id: string,
  sessionId: string | undefined,
  projectKey: string | undefined,
  owner: string | undefined
) {
  return id === projectKey || owner === id || (id.startsWith("-") && id !== sessionId)
}

async function sessionBelongsToQueue(
  id: string,
  sessionId: string | undefined,
  projectKey: string | undefined,
  tasksDir: string
) {
  if (!isSafeSessionId(sessionStoreKey(id), tasksDir)) return false
  const meta = await readTaskStoreMeta(sessionStoreKey(id), tasksDir)
  const owner = typeof meta?.cwd === "string" ? projectStoreKey(meta.cwd).key : undefined
  if (meta?.storeKind !== "session" && isLegacyProjectAddress(id, sessionId, projectKey, owner))
    return false
  return owner ? owner === projectKey : id === sessionId
}

/** Lightweight per-session metadata index for O(1) open-task-count lookups. */
export interface SessionMeta {
  /** Explicit kind for newly written stores; legacy ownership is inferred from cwd. */
  storeKind?: TaskStoreKey["kind"]
  /** Number of tasks with status "pending" or "in_progress". */
  openCount: number
  /** ISO timestamp of last update. */
  updatedAt: string
  /** Working directory of the project that owns this session. Set on first write. */
  cwd?: string
}

/** Path of the session metadata index file within a session directory. */
export const SESSION_META_FILE = ".session-meta.json"

/**
 * Recompute and persist the session metadata index after every task write.
 * Called internally by writeTask — consumers should not call this directly.
 * Silently ignores write failures (non-fatal, falls back to full scan).
 * @param dir
 * @param files
 */
async function countOpenTasks(dir: string, files: string[]): Promise<number> {
  let count = 0
  for (const f of files) {
    if (!isSessionTaskJsonFile(f)) continue
    try {
      const t = JSON.parse(await readFile(join(dir, f), "utf-8")) as { status?: string }
      if (t.status && isIncompleteTaskStatus(t.status)) count++
    } catch (e) {
      debugLog(`countOpenTasks: failed to read task file ${f}:`, e)
    }
  }
  return count
}

async function resolveMetaCwd(dir: string, cwd?: string): Promise<string | undefined> {
  try {
    const existing = JSON.parse(
      await readFile(join(dir, SESSION_META_FILE), "utf-8")
    ) as SessionMeta
    return typeof existing.cwd === "string" ? existing.cwd : cwd
  } catch {
    return cwd
  }
}

async function updateSessionMeta(
  dir: string,
  storeKind: TaskStoreKey["kind"],
  cwd?: string
): Promise<void> {
  try {
    const files = await readdir(dir)
    const openCount = await countOpenTasks(dir, files)
    const effectiveCwd = await resolveMetaCwd(dir, cwd)
    const meta: SessionMeta = {
      storeKind,
      openCount,
      updatedAt: new Date().toISOString(),
      ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
    }
    await atomicWriteJson(join(dir, SESSION_META_FILE), meta)
  } catch (e) {
    debugLog(`updateSessionMeta: failed to write session metadata to ${dir}:`, e)
  }
}

/**
 * Refresh the metadata index from what is currently on disk, then drop the
 * memoized entry for that store.
 *
 * Pruning uses this rather than `updateSessionMetaFromTasks`: the surviving
 * list a prune holds is a snapshot taken before deletion, so a task written
 * between the snapshot and the refresh is missing from it. Publishing that
 * snapshot can persist `openCount: 0` while a live open task exists, and
 * `collectIncompleteTasks` treats zero as authoritative and skips the full
 * directory read. Recounting costs one `readdir` and cannot undercount a
 * concurrent write.
 *
 * `updateSessionMeta` swallows its own write failures, so a read-only or
 * locked store still leaves the caller with its pruned view.
 */
export async function refreshSessionMetaFromDisk(
  dir: string,
  storeKind: TaskStoreKey["kind"],
  cwd?: string
): Promise<void> {
  await updateSessionMeta(dir, storeKind, cwd)
  invalidateSessionMetaForDir(dir)
}

/**
 * Drop cached metadata for a store directory.
 *
 * The cache is keyed by `<tasksDir>\0<storeDirName>`, and a project store's
 * name is itself two path segments, so the entry cannot be recovered from
 * `basename(dir)`. Rejoining each key is exact for both layouts.
 */
function invalidateSessionMetaForDir(dir: string): void {
  for (const key of [...sessionMetaCache.keys()]) {
    const separator = key.indexOf("\0")
    if (separator === -1) continue
    const tasksDir = key.slice(0, separator)
    const storeDirName = key.slice(separator + 1)
    if (join(tasksDir, storeDirName) === dir) sessionMetaCache.delete(key)
  }
}

export async function updateSessionMetaFromTasks(
  dir: string,
  tasks: readonly { status: string }[],
  storeKind: TaskStoreKey["kind"],
  cwd?: string
): Promise<void> {
  const effectiveCwd = await resolveMetaCwd(dir, cwd)
  const meta: SessionMeta = {
    storeKind,
    openCount: tasks.filter((task) => isIncompleteTaskStatus(task.status)).length,
    updatedAt: new Date().toISOString(),
    ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
  }
  await atomicWriteJson(join(dir, SESSION_META_FILE), meta)
}

/**
 * In-process cache for session metadata. Avoids repeated filesystem reads
 * within a single CLI invocation. Invalidated per-session by writeTask.
 */
const sessionMetaCache = new CappedMap<string, SessionMeta | null>(500)

/** Cache key for sessionMetaCache. */
function metaCacheKey(sessionId: string, tasksDir: string): string {
  return `${tasksDir}\0${sessionId}`
}

export interface TaskBatchWrite {
  task: Task
  audit: AuditEntry
}

export interface TaskBatchWriteResult {
  taskWrites: number
  auditWrites: number
  metadataWrites: number
  maxConcurrentTaskWrites: number
}

async function writeBoundedTaskFiles(
  dir: string,
  tasks: readonly Task[],
  concurrency = 8
): Promise<Pick<TaskBatchWriteResult, "taskWrites" | "maxConcurrentTaskWrites">> {
  let nextIndex = 0
  let taskWrites = 0
  let activeWrites = 0
  let maxConcurrentTaskWrites = 0
  const workerCount = Math.min(Math.max(1, concurrency), tasks.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++
        const task = tasks[index]
        if (!task) return
        activeWrites++
        maxConcurrentTaskWrites = Math.max(maxConcurrentTaskWrites, activeWrites)
        try {
          await atomicWriteJson(join(dir, `${task.id}.json`), task)
          taskWrites++
        } finally {
          activeWrites--
        }
      }
    })
  )
  return { taskWrites, maxConcurrentTaskWrites }
}

async function readAuditOperationIds(auditPath: string): Promise<Set<string>> {
  try {
    const entries = (await readFile(auditPath, "utf-8")).split("\n")
    const operationIds = new Set<string>()
    for (const entry of entries) {
      if (!entry) continue
      try {
        const parsed = JSON.parse(entry) as { operationId?: unknown }
        if (typeof parsed.operationId === "string") operationIds.add(parsed.operationId)
      } catch {
        // A malformed historical line does not prevent a new batch from being persisted.
      }
    }
    return operationIds
  } catch {
    return new Set()
  }
}

/**
 * Persist a coherent group of task writes for one session.
 *
 * Task files remain individually atomic, audit entries retain source order,
 * and session metadata is derived from the caller's final in-memory task list
 * exactly once. Callers own any cache/event projection that follows the batch.
 */
export async function writeTaskBatch(
  storeKey: TaskStoreKey,
  writes: readonly TaskBatchWrite[],
  finalTasks: readonly Task[],
  cwd?: string,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<TaskBatchWriteResult> {
  const sessionId = taskStoreDirName(storeKey)
  const dir = await prepareTaskStoreWrite(storeKey, tasksDir, cwd)
  const auditPath = join(dir, AUDIT_LOG_FILENAME)
  const persistedOperationIds = await readAuditOperationIds(auditPath)
  let auditWrites = 0
  for (const write of writes) {
    const operationId = write.audit.operationId
    if (operationId && persistedOperationIds.has(operationId)) continue
    await appendJsonlEntry(auditPath, write.audit)
    auditWrites++
    if (operationId) persistedOperationIds.add(operationId)
  }

  const writtenAt = new Date().toISOString()
  const taskWrites = await writeBoundedTaskFiles(
    dir,
    writes.map((write) => {
      write.task.updatedAt = writtenAt
      return write.task
    })
  )
  await updateSessionMetaFromTasks(dir, finalTasks, storeKey.kind, cwd)
  sessionMetaCache.delete(metaCacheKey(sessionId, tasksDir))
  return {
    ...taskWrites,
    auditWrites,
    metadataWrites: 1,
  }
}

/**
 * Read the session metadata index for a session directory.
 * Returns null when the index does not exist or is unreadable (caller must fall back).
 * Results are memoized within the process lifetime; writeTask invalidates the entry.
 */
export async function readSessionMeta(
  sessionId: string,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<SessionMeta | null> {
  const storeKey = await resolveLegacyTaskStoreKey(sessionId, undefined, tasksDir)
  return readTaskStoreMeta(storeKey, tasksDir)
}

/** Typed metadata access must not reinterpret a native session as a project with the same ID. */
export async function readTaskStoreMeta(
  storeKey: TaskStoreKey,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<SessionMeta | null> {
  if (!isSafeSessionId(storeKey, tasksDir)) return null
  const key = metaCacheKey(taskStoreDirName(storeKey), tasksDir)
  if (sessionMetaCache.has(key)) return sessionMetaCache.get(key)!
  const dir = await readTaskStorePath(storeKey, tasksDir)
  try {
    const text = await readFile(join(dir, SESSION_META_FILE), "utf-8")
    const meta = JSON.parse(text) as SessionMeta
    sessionMetaCache.set(key, meta)
    return meta
  } catch {
    sessionMetaCache.set(key, null)
    return null
  }
}

export async function writeTask(
  storeKey: TaskStoreKey,
  task: Task,
  cwd?: string,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<void> {
  const sessionId = taskStoreDirName(storeKey)
  const dir = await prepareTaskStoreWrite(storeKey, tasksDir, cwd)
  task.updatedAt = new Date().toISOString()
  await atomicWriteJson(join(dir, `${task.id}.json`), task)
  // Update lightweight index so status.ts can read openCount without scanning every task file.
  await updateSessionMeta(dir, storeKey.kind, cwd)
  // Invalidate in-process cache so subsequent reads reflect the write.
  sessionMetaCache.delete(metaCacheKey(sessionId, tasksDir))
  // Write-through to the global TaskStateCache (daemon path) so hooks and
  // web UI see the update without waiting for fs.watch.
  try {
    const { getGlobalTaskStateCache } = await import("./task-recovery.ts")
    getGlobalTaskStateCache()?.applyTaskUpdate(sessionId, task)
  } catch {
    // Cache not available — safe to ignore (subprocess or non-daemon path)
  }
}

/**
 * Revert a task's on-disk status to a known-valid prior status, bypassing
 * the state-machine validation in `applyStatusTransition`. Used by drift
 * reconciliation when an invalid transition (e.g. pending → completed)
 * has slipped past the PreToolUse gate and landed on disk: callers want
 * to mutate the task back to the last valid state, but the reverse step
 * itself violates the forward-only state machine.
 *
 * Writes the file directly (skipping `writeTask`) so the cache write-through
 * does not re-trigger the same drift detection, and appends an audit entry
 * marking the action as a revert. fs.watch on the daemon will reload via
 * the normal path; the new disk state matches the already-reverted cache,
 * so the reload is a no-op.
 */
export async function revertTaskStatusOnDisk(
  storeKey: TaskStoreKey,
  taskId: string,
  targetStatus: TaskStatus,
  attemptedStatus: TaskStatus,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<boolean> {
  const sessionId = taskStoreDirName(storeKey)
  const dir = await prepareTaskStoreWrite(storeKey, tasksDir)
  const filePath = join(dir, `${taskId}.json`)
  let task: Task
  try {
    const text = await readFile(filePath, "utf-8")
    task = JSON.parse(text) as Task
  } catch (e) {
    debugLog(`revertTaskStatusOnDisk: cannot read ${filePath}:`, e)
    return false
  }
  if (task.status === targetStatus) return true
  task.status = targetStatus
  task.statusChangedAt = new Date().toISOString()
  try {
    await atomicWriteJson(filePath, task)
  } catch (e) {
    debugLog(`revertTaskStatusOnDisk: cannot write ${filePath}:`, e)
    return false
  }
  sessionMetaCache.delete(metaCacheKey(sessionId, tasksDir))
  try {
    await appendJsonlEntry(join(dir, AUDIT_LOG_FILENAME), {
      timestamp: new Date().toISOString(),
      taskId,
      action: "status_change",
      oldStatus: attemptedStatus,
      newStatus: targetStatus,
      evidence: `auto-revert: invalid transition held at ${targetStatus}`,
      subject: task.subject,
    })
  } catch (e) {
    debugLog(`revertTaskStatusOnDisk: cannot append audit entry:`, e)
  }
  return true
}

export async function writeAudit(
  storeKey: TaskStoreKey,
  entry: AuditEntry,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<void> {
  const sessionId = taskStoreDirName(storeKey)
  try {
    const dir = await prepareTaskStoreWrite(storeKey, tasksDir)
    await appendJsonlEntry(join(dir, ".audit-log.jsonl"), entry)
  } catch (e) {
    debugLog(`writeAudit: failed to write audit entry for session ${sessionId}:`, e)
  }
  // Write-through audit mutations to the global TaskStateCache so hooks
  // and web UI see status changes immediately without waiting for fs.watch.
  try {
    const { getGlobalTaskStateCache } = await import("./task-recovery.ts")
    getGlobalTaskStateCache()?.applyTaskAuditSnapshot(sessionId, entry)
  } catch (e) {
    // Cache not available — safe to ignore (subprocess or non-daemon path)
    debugLog(`writeAudit: failed to apply cache update for session ${sessionId}:`, e)
  }
}
