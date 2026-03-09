/**
 * Task persistence layer — file I/O for task and audit records.
 * Owns: Task/AuditEntry types, readTasks, writeTask, writeAudit,
 *       ID utilities (parseTaskId, compareTaskIds), and STATUS_STYLE.
 */

import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { sessionPrefix } from "../session-id.ts"
import { getDefaultTaskRoots } from "../task-roots.ts"

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
  tasksDir = getDefaultTaskRoots().tasksDir
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
        // Backfill statusChangedAt from file mtime for legacy tasks
        if (!task.statusChangedAt) {
          const st = await stat(filePath)
          task.statusChangedAt = st.mtime.toISOString()
        }
        return task
      })
    )
    return tasks.sort((a, b) => compareTaskIds(a.id, b.id))
  } catch {
    return []
  }
}

export async function writeTask(sessionId: string, task: Task) {
  const dir = join(getDefaultTaskRoots().tasksDir, sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${task.id}.json`), JSON.stringify(task, null, 2))
}

export async function writeAudit(sessionId: string, entry: AuditEntry) {
  try {
    const dir = join(getDefaultTaskRoots().tasksDir, sessionId)
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, ".audit-log.jsonl"), `${JSON.stringify(entry)}\n`)
  } catch {}
}
