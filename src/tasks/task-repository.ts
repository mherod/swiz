/**
 * Task persistence layer — file I/O for task and audit records.
 * Owns: Task/AuditEntry types, readTasks, writeTask, writeAudit,
 *       ID utilities (parseTaskId, compareTaskIds), and STATUS_STYLE.
 */

import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { sessionPrefix } from "../session-id.ts"
import { createDefaultTaskStore } from "../task-roots.ts"
import { backfillTaskTimingFields } from "./task-timing.ts"

export { sessionPrefix }

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Task {
  id: string
  subject: string
  description: string
  activeForm?: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
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
  /** Cumulative milliseconds spent in in_progress status */
  elapsedMs?: number
  /** Deterministic fingerprint of the normalized subject for deduplication. */
  subjectFingerprint?: string
}

export interface AuditEntry {
  timestamp: string
  taskId: string
  action: "create" | "status_change" | "delete"
  oldStatus?: Task["status"]
  newStatus?: Task["status"]
  verificationText?: string
  evidence?: string
  subject?: string
}

export const STATUS_STYLE: Record<Task["status"], { emoji: string; color: string }> = {
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

// ─── Task I/O ────────────────────────────────────────────────────────────────

export async function readTasks(
  sessionId: string,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<Task[]> {
  const dir = join(tasksDir, sessionId)
  try {
    const files = await readdir(dir)
    const taskFiles = files.filter(
      (f) => f.endsWith(".json") && !f.startsWith(".") && f !== "compact-snapshot.json"
    )
    const tasks = await Promise.all(
      taskFiles.map(async (f) => {
        const filePath = join(dir, f)
        const task = JSON.parse(await readFile(filePath, "utf-8")) as Task
        const st = await stat(filePath)
        // Backfill timing fields for legacy tasks that predate explicit timestamps.
        if (!task.statusChangedAt) task.statusChangedAt = st.mtime.toISOString()
        backfillTaskTimingFields(task, st.mtimeMs)
        return task
      })
    )
    return tasks.sort((a, b) => compareTaskIds(a.id, b.id))
  } catch {
    return []
  }
}

/** Lightweight per-session metadata index for O(1) open-task-count lookups. */
export interface SessionMeta {
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
 * @param cwd - Working directory of the owning project. Written once; preserved on subsequent updates.
 */
async function updateSessionMeta(dir: string, cwd?: string): Promise<void> {
  try {
    const files = await readdir(dir)
    let openCount = 0
    for (const f of files) {
      if (!f.endsWith(".json") || f.startsWith(".") || f === "compact-snapshot.json") continue
      try {
        const t = JSON.parse(await readFile(join(dir, f), "utf-8")) as { status?: string }
        if (t.status === "pending" || t.status === "in_progress") openCount++
      } catch {}
    }
    // Preserve existing cwd when cwd is not provided; write it on first call that has it.
    let effectiveCwd = cwd
    if (!effectiveCwd) {
      try {
        const existing = JSON.parse(
          await readFile(join(dir, SESSION_META_FILE), "utf-8")
        ) as SessionMeta
        effectiveCwd = existing.cwd
      } catch {}
    }
    const meta: SessionMeta = {
      openCount,
      updatedAt: new Date().toISOString(),
      ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
    }
    await writeFile(join(dir, SESSION_META_FILE), JSON.stringify(meta))
  } catch {}
}

/**
 * In-process cache for session metadata. Avoids repeated filesystem reads
 * within a single CLI invocation. Invalidated per-session by writeTask.
 */
const sessionMetaCache = new Map<string, SessionMeta | null>()

/** Cache key for sessionMetaCache. */
function metaCacheKey(sessionId: string, tasksDir: string): string {
  return `${tasksDir}\0${sessionId}`
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
  const key = metaCacheKey(sessionId, tasksDir)
  if (sessionMetaCache.has(key)) return sessionMetaCache.get(key)!
  try {
    const text = await readFile(join(tasksDir, sessionId, SESSION_META_FILE), "utf-8")
    const meta = JSON.parse(text) as SessionMeta
    sessionMetaCache.set(key, meta)
    return meta
  } catch {
    sessionMetaCache.set(key, null)
    return null
  }
}

export async function writeTask(
  sessionId: string,
  task: Task,
  cwd?: string,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<void> {
  const dir = join(tasksDir, sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${task.id}.json`), JSON.stringify(task, null, 2))
  // Update lightweight index so status.ts can read openCount without scanning every task file.
  await updateSessionMeta(dir, cwd)
  // Invalidate in-process cache so subsequent reads reflect the write.
  sessionMetaCache.delete(metaCacheKey(sessionId, tasksDir))
}

export async function writeAudit(
  sessionId: string,
  entry: AuditEntry,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<void> {
  try {
    const dir = join(tasksDir, sessionId)
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, ".audit-log.jsonl"), `${JSON.stringify(entry)}\n`)
  } catch {}
}
