/**
 * Task list reconciliation — parsing and syncing TaskList responses to disk.
 *
 * Extracted from posttooluse-task-list-sync.ts to enable reuse beyond the hook.
 * Handles parsing TaskList tool responses, building/updating SessionTask records,
 * and reconciling against the filesystem.
 */

import { mkdir, readdir, rename } from "node:fs/promises"
import { join } from "node:path"
import type { PostToolHookInput } from "../schemas.ts"
import { isSessionTaskJsonFile } from "./task-file-utils.ts"
import type { SessionTask } from "./task-recovery.ts"
import { getSessionTaskPath, getSessionTasksDir } from "./task-recovery.ts"
import { atomicWriteJson, type TaskStatus, taskStatusSchema } from "./task-repository.ts"
import { getTaskCurrentDurationMs } from "./task-timing.ts"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface NormalizedTask {
  id: string
  subject: string
  status: TaskStatus
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

export type TaskSyncFailureOperation = "create" | "parse" | "update" | "list" | "archive"

export interface TaskSyncFailure {
  operation: TaskSyncFailureOperation
  taskId?: string
}

export interface SyncResult {
  created: number
  updated: number
  skipped: number
  archived: number
  failures: TaskSyncFailure[]
  /** All resolved SessionTask objects (written + unchanged) for cache write-through. */
  resolvedTasks: SessionTask[]
}

export interface TaskReconciliationIo {
  writeJson(filePath: string, data: unknown): Promise<void>
  listDirectory(dirPath: string): Promise<string[]>
  makeDirectory(dirPath: string): Promise<void>
  moveFile(sourcePath: string, destinationPath: string): Promise<void>
}

const defaultReconciliationIo: TaskReconciliationIo = {
  writeJson: atomicWriteJson,
  listDirectory: readdir,
  async makeDirectory(dirPath) {
    await mkdir(dirPath, { recursive: true })
  },
  moveFile: rename,
}

/** Hidden recoverable storage that preserves omitted task files under per-sync batches. */
export const TASKLIST_ARCHIVE_DIRNAME = ".tasklist-archive"

// ─── Parsing ────────────────────────────────────────────────────────────────

/**
 * Parse a single task object from TaskList response into normalized shape.
 * Returns null if required fields (id, subject) are missing.
 */
function parseNormalizedTask(t: Record<string, unknown>): NormalizedTask | null {
  const id = t.id !== undefined && t.id !== null ? String(t.id) : ""
  const subject = typeof t.subject === "string" ? t.subject : ""
  const status = taskStatusSchema.safeParse(t.status)
  if (!id || !subject || !status.success) return null
  return { id, subject, status: status.data }
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
  if (existing.status === task.status) return merged

  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  if (existing.status === "in_progress") {
    merged.elapsedMs = getTaskCurrentDurationMs(existing, nowMs)
  }
  merged.statusChangedAt = nowIso
  merged.startedAt = task.status === "in_progress" ? nowMs : null
  if (task.status === "completed") {
    merged.completedAt = nowMs
    merged.completionTimestamp = nowIso
  } else {
    merged.completedAt = null
    merged.completionTimestamp = undefined
    merged.completionEvidence = undefined
  }
  return merged
}

// ─── Reconciliation ─────────────────────────────────────────────────────────

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  )
}

function taskIdFromFileName(fileName: string): string {
  return fileName.slice(0, -".json".length)
}

async function archiveOmittedTaskFiles(
  tasksDir: string,
  authoritativeTaskIds: Set<string>,
  io: TaskReconciliationIo,
  result: SyncResult
): Promise<void> {
  let fileNames: string[]
  try {
    fileNames = await io.listDirectory(tasksDir)
  } catch (error) {
    if (isNotFoundError(error)) return
    result.failures.push({ operation: "list" })
    return
  }

  const omittedFiles = fileNames.filter(
    (fileName) =>
      isSessionTaskJsonFile(fileName) && !authoritativeTaskIds.has(taskIdFromFileName(fileName))
  )
  if (omittedFiles.length === 0) return

  const archiveDir = join(
    tasksDir,
    TASKLIST_ARCHIVE_DIRNAME,
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  )
  try {
    await io.makeDirectory(archiveDir)
  } catch {
    for (const fileName of omittedFiles) {
      result.failures.push({ operation: "archive", taskId: taskIdFromFileName(fileName) })
    }
    return
  }

  for (const fileName of omittedFiles) {
    const taskId = taskIdFromFileName(fileName)
    try {
      await io.moveFile(join(tasksDir, fileName), join(archiveDir, fileName))
      result.archived++
    } catch {
      result.failures.push({ operation: "archive", taskId })
    }
  }
}

async function createTaskFile(
  taskPath: string,
  task: NormalizedTask,
  io: TaskReconciliationIo,
  result: SyncResult
): Promise<void> {
  const taskRecord = buildNewTaskRecord(task, new Date().toISOString(), Date.now())
  try {
    await io.writeJson(taskPath, taskRecord)
    result.created++
    result.resolvedTasks.push(taskRecord)
  } catch {
    result.failures.push({ operation: "create", taskId: task.id })
  }
}

async function updateTaskFile(
  taskPath: string,
  existing: SessionTask,
  task: NormalizedTask,
  io: TaskReconciliationIo,
  result: SyncResult
): Promise<void> {
  const merged = updateExistingTask(existing, task)
  try {
    await io.writeJson(taskPath, merged)
    result.updated++
    result.resolvedTasks.push(merged)
  } catch {
    result.failures.push({ operation: "update", taskId: task.id })
  }
}

interface IncomingTaskContext {
  home: string
  sessionId: string
  io: TaskReconciliationIo
  result: SyncResult
}

async function reconcileIncomingTask(
  task: NormalizedTask,
  context: IncomingTaskContext
): Promise<void> {
  const taskPath = getSessionTaskPath(context.sessionId, task.id, context.home)
  if (!taskPath) return

  const file = Bun.file(taskPath)
  if (!(await file.exists())) {
    await createTaskFile(taskPath, task, context.io, context.result)
    return
  }

  let existing: SessionTask
  try {
    existing = (await file.json()) as SessionTask
  } catch {
    context.result.failures.push({ operation: "parse", taskId: task.id })
    return
  }

  if (existing.subject === task.subject && existing.status === task.status) {
    context.result.skipped++
    context.result.resolvedTasks.push(existing)
    return
  }

  await updateTaskFile(taskPath, existing, task, context.io, context.result)
}

/**
 * Reconcile a normalized task list against the filesystem.
 * For each task: creates new files, updates existing files when state changes,
 * or skips when subject and status match. Files omitted from the authoritative
 * list are moved into a hidden per-sync archive so direct disk reads cannot
 * resurrect them and operators can restore them if needed.
 */
export async function reconcileTasks(
  tasks: NormalizedTask[],
  home: string,
  sessionId: string,
  ioOverrides: Partial<TaskReconciliationIo> = {}
): Promise<SyncResult> {
  const io: TaskReconciliationIo = { ...defaultReconciliationIo, ...ioOverrides }
  const result: SyncResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    archived: 0,
    failures: [],
    resolvedTasks: [],
  }

  const context: IncomingTaskContext = { home, sessionId, io, result }
  for (const task of tasks) {
    await reconcileIncomingTask(task, context)
  }

  if (result.failures.length > 0) return result

  const tasksDir = getSessionTasksDir(sessionId, home)
  if (!tasksDir) {
    result.failures.push({ operation: "list" })
    return result
  }
  await archiveOmittedTaskFiles(tasksDir, new Set(tasks.map((task) => task.id)), io, result)

  return result
}
