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

export type TaskListParseResult =
  | { kind: "recognized"; tasks: NormalizedTask[] }
  | {
      kind: "unrecognized"
      hasContent: boolean
      reason: "missing-response" | "invalid-json" | "unsupported-shape" | "malformed-task"
    }

type UnrecognizedTaskListResult = Extract<TaskListParseResult, { kind: "unrecognized" }>
type DecodedToolResponse = { kind: "decoded"; value: unknown } | UnrecognizedTaskListResult

interface SyncResult {
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
function parseNormalizedTask(t: Record<string, unknown>): NormalizedTask | null {
  const id = t.id !== undefined && t.id !== null ? String(t.id) : ""
  const subject = typeof t.subject === "string" ? t.subject : ""
  const status = typeof t.status === "string" ? t.status : "pending"
  if (!id || !subject) return null
  return { id, subject, status }
}

function decodeToolResponse(raw: PostToolHookInput["tool_response"]): DecodedToolResponse {
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim().length === 0)) {
    return { kind: "unrecognized", hasContent: false, reason: "missing-response" }
  }
  if (typeof raw !== "string") return { kind: "decoded", value: raw }

  try {
    return { kind: "decoded", value: JSON.parse(raw) }
  } catch {
    return { kind: "unrecognized", hasContent: true, reason: "invalid-json" }
  }
}

function parseTaskItems(items: unknown[]): TaskListParseResult {
  const tasks: NormalizedTask[] = []
  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      return { kind: "unrecognized", hasContent: true, reason: "malformed-task" }
    }
    const normalized = parseNormalizedTask(item as Record<string, unknown>)
    if (!normalized) {
      return { kind: "unrecognized", hasContent: true, reason: "malformed-task" }
    }
    tasks.push(normalized)
  }
  return { kind: "recognized", tasks }
}

/**
 * Parse complete tool response into normalized tasks.
 * Distinguishes authoritative task arrays, including an empty array, from
 * missing, malformed, or unsupported response shapes.
 */
export function parseToolResponse(raw: PostToolHookInput["tool_response"]): TaskListParseResult {
  const decoded = decodeToolResponse(raw)
  if (decoded.kind === "unrecognized") return decoded
  if (typeof decoded.value !== "object" || decoded.value === null || Array.isArray(decoded.value)) {
    return { kind: "unrecognized", hasContent: true, reason: "unsupported-shape" }
  }

  const items = (decoded.value as Record<string, unknown>).tasks
  if (!Array.isArray(items)) {
    return { kind: "unrecognized", hasContent: true, reason: "unsupported-shape" }
  }
  return parseTaskItems(items)
}

// ─── Task record building ────────────────────────────────────────────────────

/**
 * Build a new SessionTask from a normalized task with current timestamps.
 * Sets initial timing fields based on status: in_progress gets startedAt,
 * completed gets completedAt and completionTimestamp.
 */
function buildNewTaskRecord(task: NormalizedTask, nowIso: string, nowMs: number): SessionTask {
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
function updateExistingTask(existing: SessionTask, task: NormalizedTask): SessionTask {
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
