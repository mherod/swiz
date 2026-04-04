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

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EventTaskState {
  id: string
  status: string
  subject: string
}

// ─── Module-level state ─────────────────────────────────────────────────────

const sessionTasks = new Map<string, EventTaskState[]>()

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
}

/**
 * Apply a TaskUpdate event: update status and/or subject of an existing task.
 * If the task isn't in the map yet (first event for this session), it's added.
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
    tasks[idx] = {
      id: taskId,
      status: updates.status ?? existing.status,
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
 */
export function applyTaskListEvent(sessionId: string, tasks: EventTaskState[]): void {
  sessionTasks.set(sessionId, [...tasks])
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
}

/**
 * Clear all in-memory state (used in tests and daemon shutdown).
 */
export function clearAllEventState(): void {
  sessionTasks.clear()
}

/**
 * Number of sessions with event state (for diagnostics).
 */
export function eventStateSessionCount(): number {
  return sessionTasks.size
}
