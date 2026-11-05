/**
 * Cancel open tasks that belong to agent sessions nobody has seen for
 * UNSEEN_SESSION_TASK_CANCEL_AGE_MS.
 *
 * Two stores, two notions of ownership:
 *
 * - Per-session stores are directories named for the session id, so ownership
 *   is exact. A session counts as seen at the latest of: a caller-supplied
 *   sighting (the daemon's live dispatch activity and transcript mtime) and the
 *   newest write to any task in its store. Only when all of those are older
 *   than the cutoff are its pending/in_progress tasks cancelled.
 * - The shared project store records no creating session, so a task's own last
 *   update stands in for its session's sighting. Like pruning, this store is
 *   only maintained from the swiz MCP task tools (see task-prune.ts).
 *
 * A record or session with no usable timestamp is kept: its age is unknown and
 * guessing would cancel live work. A record already past STALE_TASK_PRUNE_AGE_MS
 * is left to pruning, since cancelling it would refresh its age and delay deletion. Every cancellation goes through
 * `updateStatus`, so it is validated, audited and written through the cache.
 */

import { readdir } from "node:fs/promises"
import { debugLog } from "../debug.ts"
import { projectKeyFromCwd } from "../project-key.ts"
import { createDefaultTaskStore } from "../task-roots.ts"
import {
  STALE_TASK_PRUNE_AGE_MS,
  UNSEEN_SESSION_TASK_CANCEL_AGE_MS,
} from "./task-governance-constants.ts"
import {
  isIncompleteTaskStatus,
  readTaskStore,
  readTaskStoreMeta,
  type Task,
} from "./task-repository.ts"
import { updateStatus } from "./task-service.ts"
import {
  isSafeSessionId,
  PROJECT_TASK_NAMESPACE,
  sessionStoreKey,
  type TaskStoreKey,
} from "./task-store-path.ts"
import { getTaskLastUpdatedMs } from "./task-timing.ts"

export interface CancelledTaskRef {
  storeKey: TaskStoreKey
  taskId: string
  subject: string
}

/** Latest sighting of a session from outside its task store, or null when unknown. */
export type SessionSightingLookup = (
  sessionId: string,
  cwd: string | undefined
) => number | null | Promise<number | null>

export interface UnseenSessionSweepOptions {
  tasksDir?: string
  nowMs?: number
  maxAgeMs?: number
  sessionLastSeenMs?: SessionSightingLookup
}

function maxKnown(values: ReadonlyArray<number | null | undefined>): number | null {
  let best: number | null = null
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && (best === null || value > best)) {
      best = value
    }
  }
  return best
}

function newestTaskActivityMs(tasks: readonly Task[]): number | null {
  return maxKnown(tasks.map((task) => getTaskLastUpdatedMs(task)))
}

/**
 * Open tasks this rule may cancel. A task already past the stale prune age is
 * left for pruning: cancelling stamps a fresh `updatedAt`, which would rescue a
 * dead row from deletion for another full prune window.
 */
function cancellableOpenTasks(tasks: readonly Task[], nowMs: number): Task[] {
  const pruneCutoff = nowMs - STALE_TASK_PRUNE_AGE_MS
  return tasks.filter((task) => {
    if (!isIncompleteTaskStatus(task.status)) return false
    const lastMs = getTaskLastUpdatedMs(task)
    return lastMs !== null && lastMs >= pruneCutoff
  })
}

async function cancelTasks(
  storeKey: TaskStoreKey,
  tasks: readonly Task[],
  reason: string,
  tasksDir: string,
  cwd: string | undefined
): Promise<CancelledTaskRef[]> {
  const cancelled: CancelledTaskRef[] = []
  for (const task of tasks) {
    try {
      await updateStatus(storeKey, task.id, "cancelled", {
        evidence: `note: ${reason}`,
        skipWipLimit: true,
        tasksDir,
        filterCwd: cwd,
      })
      cancelled.push({ storeKey, taskId: task.id, subject: task.subject })
    } catch (error) {
      // A concurrent writer may have moved the task on; leave it to the next sweep.
      debugLog(`cancelTasks: could not cancel #${task.id}:`, error)
    }
  }
  return cancelled
}

/**
 * Shared project store: cancel each open task untouched for longer than `maxAgeMs`.
 * Call only from the MCP task tools, which own maintenance of this store.
 */
export async function cancelIdleProjectTasks(
  projectKey: string,
  options: Omit<UnseenSessionSweepOptions, "sessionLastSeenMs"> = {}
): Promise<CancelledTaskRef[]> {
  const tasksDir = options.tasksDir ?? createDefaultTaskStore().tasksDir
  const nowMs = options.nowMs ?? Date.now()
  const cutoff = nowMs - (options.maxAgeMs ?? UNSEEN_SESSION_TASK_CANCEL_AGE_MS)
  const storeKey: TaskStoreKey = { kind: "project", key: projectKey }
  if (!isSafeSessionId(storeKey, tasksDir)) return []
  const idle = cancellableOpenTasks(await readTaskStore(storeKey, tasksDir), nowMs).filter(
    (task) => (getTaskLastUpdatedMs(task) ?? cutoff) < cutoff
  )
  if (idle.length === 0) return []
  const hours = Math.round((nowMs - cutoff) / 3_600_000)
  return cancelTasks(
    storeKey,
    idle,
    `auto-cancelled — untouched for over ${hours}h; its session is no longer active`,
    tasksDir,
    undefined
  )
}

type StoreMeta = Awaited<ReturnType<typeof readTaskStoreMeta>>

/** Whether a store directory is a project address rather than an agent session. */
function isProjectAddress(name: string, meta: StoreMeta): boolean {
  if (name === PROJECT_TASK_NAMESPACE) return true
  if (meta?.storeKind === "project") return true
  if (meta?.storeKind === "session") return false
  if (typeof meta?.cwd === "string" && projectKeyFromCwd(meta.cwd) === name) return true
  // Legacy project stores are named by project key, which always starts with "-".
  return name.startsWith("-")
}

interface SweepContext {
  tasksDir: string
  nowMs: number
  cutoffMs: number
  maxAgeMs: number
  sessionLastSeenMs?: SessionSightingLookup
}

/**
 * Latest sighting of a session, or undefined when the lookup failed. Failing
 * closed matters: an unanswerable lookup must not cancel live work.
 */
async function sessionLastSeenMs(
  sessionId: string,
  cwd: string | undefined,
  tasks: readonly Task[],
  lookup: SessionSightingLookup | undefined
): Promise<number | null | undefined> {
  try {
    const sighting = (await lookup?.(sessionId, cwd)) ?? null
    return maxKnown([sighting, newestTaskActivityMs(tasks)])
  } catch (error) {
    debugLog(`cancelTasksOfUnseenSessions: sighting lookup failed for ${sessionId}:`, error)
    return undefined
  }
}

async function sweepSessionStore(
  sessionId: string,
  ctx: SweepContext
): Promise<CancelledTaskRef[]> {
  const storeKey = sessionStoreKey(sessionId)
  if (!isSafeSessionId(storeKey, ctx.tasksDir)) return []
  const meta = await readTaskStoreMeta(storeKey, ctx.tasksDir, true)
  if (isProjectAddress(sessionId, meta)) return []

  const tasks = await readTaskStore(storeKey, ctx.tasksDir)
  const open = cancellableOpenTasks(tasks, ctx.nowMs)
  if (open.length === 0) return []

  const cwd = typeof meta?.cwd === "string" ? meta.cwd : undefined
  const lastSeenMs = await sessionLastSeenMs(sessionId, cwd, tasks, ctx.sessionLastSeenMs)
  if (lastSeenMs == null || lastSeenMs >= ctx.cutoffMs) return []

  const hours = Math.round(ctx.maxAgeMs / 3_600_000)
  const reason =
    `auto-cancelled — session ${sessionId} not seen for over ${hours}h ` +
    `(last seen ${new Date(lastSeenMs).toISOString()})`
  return cancelTasks(storeKey, open, reason, ctx.tasksDir, cwd)
}

/**
 * Per-session stores: cancel the open tasks of every session not seen for longer
 * than `maxAgeMs`. Returns what was cancelled.
 */
export async function cancelTasksOfUnseenSessions(
  options: UnseenSessionSweepOptions = {}
): Promise<CancelledTaskRef[]> {
  const tasksDir = options.tasksDir ?? createDefaultTaskStore().tasksDir
  const maxAgeMs = options.maxAgeMs ?? UNSEEN_SESSION_TASK_CANCEL_AGE_MS
  const nowMs = options.nowMs ?? Date.now()
  const ctx: SweepContext = {
    tasksDir,
    maxAgeMs,
    nowMs,
    cutoffMs: nowMs - maxAgeMs,
    sessionLastSeenMs: options.sessionLastSeenMs,
  }
  const entries = await readdir(tasksDir, { withFileTypes: true }).catch(() => [])
  const cancelled: CancelledTaskRef[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) cancelled.push(...(await sweepSessionStore(entry.name, ctx)))
  }
  return cancelled
}
