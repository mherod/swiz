/**
 * In-memory task state maintained from PostToolUse hook event payloads.
 *
 * The dispatch process runs inline hooks in-process, so a module-level Map
 * is shared across all hooks within a single dispatch cycle. Hooks that fire
 * on TaskCreate/TaskUpdate/TaskList write into this map; downstream hooks
 * (e.g. posttooluse-task-count-context) read from it instead of disk.
 *
 * This eliminates the stale-read problem caused by Claude's native task tools
 * writing to disk asynchronously — the PostToolUse hook fires before the disk
 * write lands, but the event payload contains the post-mutation state.
 *
 * Lifecycle:
 *   - Updated by posttooluse-task-audit-sync (TaskCreate/TaskUpdate)
 *   - Updated by posttooluse-task-list-sync (TaskList bulk reconciliation)
 *   - Read by posttooluse-task-count-context for count injection
 *   - Pruned per session via pruneSession() on session eviction
 */

import { debugLog } from "../debug.ts"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EventTaskState {
  id: string
  status: string
  subject: string
}

// ─── Transition validation ─────────────────────────────────────────────────

/**
 * Lightweight mirror of VALID_TRANSITIONS from task-service.ts.
 * Kept as a local constant to avoid circular imports — task-service.ts
 * imports from this module's sibling (task-recovery.ts → task-event-state.ts).
 */
const VALID_TRANSITIONS: Record<string, Set<string>> = {
  pending: new Set(["in_progress", "cancelled"]),
  in_progress: new Set(["completed", "pending", "cancelled"]),
  completed: new Set(["in_progress"]),
  cancelled: new Set(["pending", "in_progress"]),
}

/**
 * Check whether a status transition is valid. Returns true when valid
 * (including same-status no-ops), false when the transition violates the
 * state machine.
 */
export function isValidTransition(oldStatus: string, newStatus: string): boolean {
  if (oldStatus === newStatus) return true
  const allowed = VALID_TRANSITIONS[oldStatus]
  return allowed !== undefined && allowed.has(newStatus)
}

/**
 * Log a warning when an invalid state transition is detected in an
 * unvalidated mutation path. Sets the per-session reconciliation flag
 * so downstream PreToolUse hooks can force a TaskList call to resync.
 */
export function warnInvalidTransition(
  layer: string,
  sessionId: string,
  taskId: string,
  oldStatus: string,
  newStatus: string
): void {
  debugLog(
    `[task-transition] INVALID ${layer}: task #${taskId} ${oldStatus} → ${newStatus} ` +
      `(session ${sessionId.slice(0, 8)}…). Reconciliation flag set.`
  )
  reconciliationNeeded.add(sessionId)
}

/**
 * Compute the shortest path of valid intermediate transitions from
 * `oldStatus` to `newStatus`. Returns the intermediate steps (excluding
 * `oldStatus`, including `newStatus`), or null if no valid path exists
 * (max depth 3 to avoid cycles in the small state graph).
 *
 * Examples:
 *   computeTransitionPath("pending", "completed") → ["in_progress", "completed"]
 *   computeTransitionPath("pending", "in_progress") → ["in_progress"]
 *   computeTransitionPath("completed", "cancelled") → ["in_progress", "cancelled"]
 */
export function computeTransitionPath(oldStatus: string, newStatus: string): string[] | null {
  if (oldStatus === newStatus) return []
  if (isValidTransition(oldStatus, newStatus)) return [newStatus]

  // BFS over valid transitions (max depth 3 — graph has 4 nodes)
  const queue: Array<{ status: string; path: string[] }> = [{ status: oldStatus, path: [] }]
  const visited = new Set<string>([oldStatus])

  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.path.length >= 3) continue

    const allowed = VALID_TRANSITIONS[current.status]
    if (!allowed) continue

    for (const next of allowed) {
      if (visited.has(next)) continue
      const newPath = [...current.path, next]
      if (next === newStatus) return newPath
      visited.add(next)
      queue.push({ status: next, path: newPath })
    }
  }
  return null
}

// ─── Module-level state ─────────────────────────────────────────────────────

const sessionTasks = new Map<string, EventTaskState[]>()

/**
 * Per-session flag indicating that an invalid state transition was detected
 * in an unvalidated mutation path. When set, PreToolUse hooks should force
 * a TaskList call to reconcile in-memory state with the authoritative source.
 *
 * Cleared when a TaskList event replaces the session's state (full resync).
 */
const reconciliationNeeded = new Set<string>()

// ─── Write API ──────────────────────────────────────────────────────────────

/**
 * Apply a TaskCreate event: append a new task with status "pending".
 * The taskId comes from scanning the session task directory for the highest
 * numeric file (done by audit-sync), or from tool_input when available.
 */
export function applyTaskCreateEvent(sessionId: string, taskId: string, subject: string): void {
  const tasks = sessionTasks.get(sessionId) ?? []
  // Avoid duplicates — if a task with this ID already exists, update it
  const idx = tasks.findIndex((t) => t.id === taskId)
  if (idx >= 0) {
    tasks[idx] = { id: taskId, status: "pending", subject }
  } else {
    tasks.push({ id: taskId, status: "pending", subject })
  }
  sessionTasks.set(sessionId, tasks)

  // Post-condition: after creating a task, there must be at least one
  // incomplete (pending/in_progress) task. If not, the event state is
  // inconsistent — flag for reconciliation via TaskList.
  const hasIncomplete = tasks.some((t) => t.status === "pending" || t.status === "in_progress")
  if (!hasIncomplete) {
    debugLog(
      `[task-transition] impossible state after create: task #${taskId} in session ` +
        `${sessionId.slice(0, 8)}… has zero incomplete tasks. Reconciliation flag set.`
    )
    reconciliationNeeded.add(sessionId)
  }
}

/**
 * Apply a TaskUpdate event: update status and/or subject of an existing task.
 * If the task isn't in the map yet (first event for this session), it's added.
 * Logs a warning and sets the reconciliation flag on invalid transitions.
 */
export function applyTaskUpdateEvent(
  sessionId: string,
  taskId: string,
  updates: { status?: string; subject?: string }
): void {
  const tasks = sessionTasks.get(sessionId) ?? []
  const idx = tasks.findIndex((t) => t.id === taskId)
  if (idx >= 0) {
    const existing = tasks[idx]!
    const newStatus = updates.status ?? existing.status
    if (updates.status && !isValidTransition(existing.status, newStatus)) {
      warnInvalidTransition("event-state", sessionId, taskId, existing.status, newStatus)
    }
    tasks[idx] = {
      id: taskId,
      status: newStatus,
      subject: updates.subject ?? existing.subject,
    }
  } else {
    // Task not yet tracked — add with what we know
    tasks.push({
      id: taskId,
      status: updates.status ?? "pending",
      subject: updates.subject ?? "",
    })
  }
  sessionTasks.set(sessionId, tasks)
}

/**
 * Apply a TaskList bulk sync: replace the session's entire task list with the
 * authoritative state from the TaskList tool response.
 * Clears the reconciliation flag since TaskList is the full resync point.
 */
export function applyTaskListEvent(sessionId: string, tasks: EventTaskState[]): void {
  sessionTasks.set(sessionId, [...tasks])
  reconciliationNeeded.delete(sessionId)
}

// ─── Read API ───────────────────────────────────────────────────────────────

/**
 * Get the current in-memory task state for a session.
 * Returns null when no events have been recorded for this session — callers
 * should fall back to disk reads in that case.
 */
export function getSessionEventState(sessionId: string): EventTaskState[] | null {
  return sessionTasks.get(sessionId) ?? null
}

/**
 * Check whether any event state exists for a session.
 */
export function hasSessionEventState(sessionId: string): boolean {
  return sessionTasks.has(sessionId)
}

/**
 * Check whether a session needs task reconciliation due to an invalid
 * state transition detected in an unvalidated mutation path.
 * PreToolUse hooks should call this and force a TaskList when true.
 */
export function needsReconciliation(sessionId: string): boolean {
  return reconciliationNeeded.has(sessionId)
}

/**
 * Clear the reconciliation flag for a session. Called after a TaskList
 * resync has been performed.
 */
export function clearReconciliation(sessionId: string): void {
  reconciliationNeeded.delete(sessionId)
}

/**
 * Get the freshest task state for a session: event state when available
 * (zero I/O, updated synchronously by PostToolUse hooks), falling back
 * to a disk read via readSessionTasksFresh.
 *
 * Use this in PreToolUse and Stop hooks where Claude's native async disk
 * writes may not have landed yet but the event state is already current.
 */
export async function readSessionTasksFreshest(sessionId: string): Promise<EventTaskState[]> {
  const eventState = sessionTasks.get(sessionId)
  if (eventState && eventState.length > 0) return eventState

  const { readSessionTasksFresh } = await import("./task-recovery.ts")
  const diskTasks = await readSessionTasksFresh(sessionId)
  return diskTasks.map((t) => ({ id: t.id, status: t.status, subject: t.subject ?? "" }))
}

/**
 * Overlay in-memory event state statuses onto disk-read tasks.
 * Disk tasks retain full fields (timing, evidence); only the `status`
 * field is replaced with the fresher value from event state when available.
 * Mutates the input array in place and returns it for convenience.
 */
export function overlayEventState<T extends { id: string; status: string }>(
  tasks: T[],
  sessionId: string
): T[] {
  const eventState = sessionTasks.get(sessionId)
  if (!eventState || eventState.length === 0) return tasks
  const statusById = new Map(eventState.map((e) => [e.id, e.status]))
  for (const t of tasks) {
    const freshStatus = statusById.get(t.id)
    if (freshStatus && freshStatus !== t.status) {
      if (!isValidTransition(t.status, freshStatus)) {
        warnInvalidTransition("overlay", sessionId, t.id, t.status, freshStatus)
      }
      t.status = freshStatus
    }
  }
  return tasks
}

// ─── Seeding ────────────────────────────────────────────────────────────────

async function readTaskEventStatesFromDir(tasksDir: string): Promise<EventTaskState[]> {
  const { readdir } = await import("node:fs/promises")
  let files: string[]
  try {
    files = await readdir(tasksDir)
  } catch {
    return []
  }
  const tasks: EventTaskState[] = []
  for (const f of files) {
    if (!f.endsWith(".json") || f.startsWith(".")) continue
    try {
      const data = (await Bun.file(`${tasksDir}/${f}`).json()) as Record<string, unknown>
      if (typeof data.id === "string" && typeof data.status === "string") {
        tasks.push({
          id: data.id,
          status: data.status,
          subject: typeof data.subject === "string" ? data.subject : "",
        })
      }
    } catch {
      // skip unreadable files
    }
  }
  return tasks
}

/**
 * Seed event state from task files on disk. Only populates when no event
 * state exists for this session yet — avoids overwriting fresher data from
 * PostToolUse hooks that already fired.
 *
 * Call this alongside `watchSession()` when a session first dispatches so
 * task counts are accurate from the very first tool call.
 */
export async function seedSessionFromDisk(sessionId: string, tasksDir: string): Promise<void> {
  if (sessionTasks.has(sessionId)) return
  const tasks = await readTaskEventStatesFromDir(tasksDir)
  if (tasks.length > 0) {
    sessionTasks.set(sessionId, tasks)
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

/**
 * Remove all in-memory state for a session.
 */
export function pruneSession(sessionId: string): void {
  sessionTasks.delete(sessionId)
  reconciliationNeeded.delete(sessionId)
}

/**
 * Clear all in-memory state (used in tests and daemon shutdown).
 */
export function clearAllEventState(): void {
  sessionTasks.clear()
  reconciliationNeeded.clear()
}

/**
 * Number of sessions with event state (for diagnostics).
 */
export function eventStateSessionCount(): number {
  return sessionTasks.size
}
