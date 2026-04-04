/**
 * Audit log reading and verification utilities.
 *
 * Provides structured access to the per-session `.audit-log.jsonl` files
 * written by `writeAudit()` in `task-repository.ts`. Used by tests and
 * stop hooks that need to verify task lifecycle integrity.
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createDefaultTaskStore } from "../task-roots.ts"
import { parseJsonlTailUntyped } from "../utils/jsonl.ts"
import { type AuditEntry, type TaskMutationAction, writeAudit } from "./task-repository.ts"

const AUDIT_LOG_FILENAME = ".audit-log.jsonl"

/**
 * Read the full audit log for a session, returned newest-last.
 * Returns an empty array if the file doesn't exist or is unreadable.
 */
export async function readAuditLog(
  sessionId: string,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<AuditEntry[]> {
  try {
    const logPath = join(tasksDir, sessionId, AUDIT_LOG_FILENAME)
    const content = await readFile(logPath, "utf-8")
    const lines = content.trim().split("\n").filter(Boolean)
    return lines.map((line) => JSON.parse(line) as AuditEntry)
  } catch {
    return []
  }
}

/**
 * Read the N most recent audit entries for a session.
 * Uses `parseJsonlTailUntyped` for efficient tail reading.
 */
export async function readRecentAuditEntries(
  sessionId: string,
  count: number,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<AuditEntry[]> {
  try {
    const logPath = join(tasksDir, sessionId, AUDIT_LOG_FILENAME)
    const content = await readFile(logPath, "utf-8")
    return parseJsonlTailUntyped(content, count) as AuditEntry[]
  } catch {
    return []
  }
}

/**
 * Get the single most recent audit entry for a session, or null if none.
 */
export async function getLastAuditEntry(
  sessionId: string,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<AuditEntry | null> {
  const entries = await readRecentAuditEntries(sessionId, 1, tasksDir)
  return entries[0] ?? null
}

/**
 * Verify that an audit entry matches expected action and task ID.
 * Returns null on success, or an error message describing the mismatch.
 */
export function verifyAuditEntry(
  entry: AuditEntry,
  expected: { taskId?: string; action?: TaskMutationAction; oldStatus?: string; newStatus?: string }
): string | null {
  const mismatches: string[] = []
  if (expected.taskId !== undefined && entry.taskId !== expected.taskId) {
    mismatches.push(`taskId: expected "${expected.taskId}", got "${entry.taskId}"`)
  }
  if (expected.action !== undefined && entry.action !== expected.action) {
    mismatches.push(`action: expected "${expected.action}", got "${entry.action}"`)
  }
  if (expected.oldStatus !== undefined && entry.oldStatus !== expected.oldStatus) {
    mismatches.push(`oldStatus: expected "${expected.oldStatus}", got "${entry.oldStatus}"`)
  }
  if (expected.newStatus !== undefined && entry.newStatus !== expected.newStatus) {
    mismatches.push(`newStatus: expected "${expected.newStatus}", got "${entry.newStatus}"`)
  }
  return mismatches.length > 0 ? `Audit entry mismatch: ${mismatches.join("; ")}` : null
}

/**
 * Append a new audit entry to a session's audit log.
 *
 * This is a convenience wrapper around `writeAudit()` from `task-repository.ts`
 * that auto-fills the `timestamp` field when not provided.
 */
export async function appendAuditEntry(
  sessionId: string,
  entry: Omit<AuditEntry, "timestamp"> & { timestamp?: string },
  tasksDir?: string
): Promise<void> {
  const full: AuditEntry = {
    timestamp: entry.timestamp ?? new Date().toISOString(),
    ...entry,
  }
  await writeAudit(sessionId, full, tasksDir)
}
