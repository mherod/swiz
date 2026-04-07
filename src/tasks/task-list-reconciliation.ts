/**
 * Task list reconciliation — parsing and syncing TaskList responses to disk.
 *
 * Extracted from posttooluse-task-list-sync.ts to enable reuse beyond the hook.
 * Handles parsing TaskList tool responses, building/updating SessionTask records,
 * and reconciling against the filesystem.
 */

import type { PostToolHookInput } from "../schemas.ts"
import type { SessionTask } from "./task-recovery.ts"
import { getSessionTaskPath } from "./task-recovery.ts"
import { getTaskCurrentDurationMs } from "./task-timing.ts"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface NormalizedTask {
  id: string
  subject: string
  status: string
}

export interface SyncResult {
  created: number
  updated: number
  skipped: number
  /** All resolved SessionTask objects (written + unchanged) for cache write-through. */
  resolvedTasks: SessionTask[]
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/**
 * Parse a single task object from TaskList response into normalized shape.
 * Returns null if required fields (id, subject) are missing.
 */
export function parseNormalizedTask(t: Record<string, any>): NormalizedTask | null {
  const id = t.id !== undefined && t.id !== null ? String(t.id) : ""
  const subject = typeof t.subject === "string" ? t.subject : ""
  const status = typeof t.status === "string" ? t.status : "pending"
  if (!id || !subject) return null
  return { id, subject, status }
}

/**
 * Extract tasks array from raw tool response (string JSON or object).
 * Returns null if response is not a valid object with a `tasks` array.
 */
export function parseRawTasks(raw: PostToolHookInput["tool_response"]): unknown[] | null {
  if (!raw) return null
  let parsed: unknown = raw
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  const items = (parsed as Record<string, any>).tasks
  return Array.isArray(items) ? items : null
}

/**
 * Parse complete tool response into normalized tasks.
 * Filters out malformed items and returns array of valid NormalizedTask objects.
 */
export function parseToolResponse(raw: PostToolHookInput["tool_response"]): NormalizedTask[] {
  const items = parseRawTasks(raw)
  if (!items) return []
  const result: NormalizedTask[] = []
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue
    const normalized = parseNormalizedTask(item as Record<string, any>)
    if (normalized) result.push(normalized)
  }
  return result
}

// ─── Task record building ────────────────────────────────────────────────────

/**
 * Build a new SessionTask from a normalized task with current timestamps.
 * Sets initial timing fields based on status: in_progress gets startedAt,
 * completed gets completedAt and completionTimestamp.
 */
export function buildNewTaskRecord(
  task: NormalizedTask,
  nowIso: string,
  nowMs: number
): SessionTask {
  return {
    id: task.id,
    subject: task.subject,
    status: task.status,
    statusChangedAt: nowIso,
    elapsedMs: 0,
    startedAt: task.status === "in_progress" ? nowMs : null,
    completedAt: task.status === "completed" ? nowMs : null,
    ...(task.status === "completed" ? { completionTimestamp: nowIso } : {}),
  }
}

/**
 * Merge new normalized task state into existing SessionTask, updating timing.
 * When transitioning out of in_progress, accumulates elapsedMs.
 * Updates statusChangedAt and sets completion fields when entering completed.
 */
export function updateExistingTask(existing: SessionTask, task: NormalizedTask): SessionTask {
  const merged: SessionTask = { ...existing, subject: task.subject, status: task.status }
  const nowIso = new Date().toISOString()
  const nowMs = Date.now()
  if (existing.status === "in_progress") {
    merged.elapsedMs = getTaskCurrentDurationMs(existing, nowMs)
  }
  merged.statusChangedAt = nowIso
  if (task.status === "in_progress") merged.startedAt = nowMs
  if (task.status === "completed") {
    merged.completedAt = nowMs
    if (!merged.completionTimestamp) merged.completionTimestamp = nowIso
  }
  return merged
}

// ─── Reconciliation ─────────────────────────────────────────────────────────

/**
 * Reconcile a normalized task list against the filesystem.
 * For each task: creates new files, updates existing files when state changes,
 * or skips when subject and status match. Returns sync counts and all resolved tasks.
 */
export async function reconcileTasks(
  tasks: NormalizedTask[],
  home: string,
  sessionId: string
): Promise<SyncResult> {
  const result: SyncResult = { created: 0, updated: 0, skipped: 0, resolvedTasks: [] }

  for (const task of tasks) {
    const taskPath = getSessionTaskPath(sessionId, task.id, home)
    if (!taskPath) continue

    const file = Bun.file(taskPath)
    const exists = await file.exists()

    if (!exists) {
      const taskRecord = buildNewTaskRecord(task, new Date().toISOString(), Date.now())
      try {
        await Bun.write(taskPath, JSON.stringify(taskRecord, null, 2))
        result.created++
        result.resolvedTasks.push(taskRecord)
      } catch {}
      continue
    }

    let existing: SessionTask
    try {
      existing = (await file.json()) as SessionTask
    } catch {
      result.skipped++
      continue
    }

    if (existing.subject === task.subject && existing.status === task.status) {
      result.skipped++
      result.resolvedTasks.push(existing)
      continue
    }

    const merged = updateExistingTask(existing, task)
    try {
      await Bun.write(taskPath, JSON.stringify(merged, null, 2))
      result.updated++
      result.resolvedTasks.push(merged)
    } catch {
      result.skipped++
      result.resolvedTasks.push(existing)
    }
  }

  return result
}
