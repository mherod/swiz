#!/usr/bin/env bun
// Consolidated PostToolUse task synchronization hooks.
//
// Contains 2 hook objects covering:
//   1. Task Audit Sync — writes audit log entries for TaskCreate/TaskUpdate,
//      updates in-memory event state, and writes through to daemon cache.
//   2. Task List Sync — reconciles TaskList responses to the file-based task
//      store, updates event state, and emits count context.
//
// Each hook is exported as a named export for manifest registration.
// Original files are thin wrappers for standalone subprocess execution.

import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { resolveSafeSessionId } from "../src/session-id.ts"
import { buildCountSummaryFromTasks } from "../src/tasks/task-count-summary.ts"
import {
  applyTaskCreateEvent,
  applyTaskListEvent,
  applyTaskUpdateEvent,
} from "../src/tasks/task-event-state.ts"
import {
  applyCacheAuditWriteThrough,
  applyCacheTaskListSnapshot,
  findLatestTaskId,
  getSessionTaskPath,
  getSessionTasksDir,
  type SessionTask,
} from "../src/tasks/task-recovery.ts"
import { getTaskCurrentDurationMs } from "../src/tasks/task-timing.ts"
import { buildContextHookOutput } from "../src/utils/hook-utils.ts"
import { type PostToolHookInput, toolHookInputSchema } from "./schemas.ts"

// ═══════════════════════════════════════════════════════════════════════════
// § 1. Task Audit Sync (TaskCreate / TaskUpdate / TodoWrite)
// ═══════════════════════════════════════════════════════════════════════════

interface AuditEntry {
  timestamp: string
  taskId: string
  action: "create" | "status_change"
  oldStatus?: string
  newStatus?: string
  subject?: string
  source: "native-tool-sync"
}

async function writeAuditEntry(tasksDir: string, entry: AuditEntry): Promise<void> {
  try {
    await mkdir(tasksDir, { recursive: true })
    await appendFile(join(tasksDir, ".audit-log.jsonl"), `${JSON.stringify(entry)}\n`)
  } catch {
    // Fail silently — audit sync is best-effort
  }
}

async function handleTaskCreate(tasksDir: string, subject: string): Promise<void> {
  const taskId = await findLatestTaskId(tasksDir)
  if (!taskId) return

  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    taskId,
    action: "create",
    newStatus: "pending",
    subject,
    source: "native-tool-sync",
  }
  await writeAuditEntry(tasksDir, entry)
}

async function handleTaskUpdate(
  tasksDir: string,
  taskId: string,
  subject: string,
  newStatus: string
): Promise<void> {
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    taskId,
    action: "status_change",
    newStatus: newStatus || undefined,
    subject: subject || undefined,
    source: "native-tool-sync",
  }
  await writeAuditEntry(tasksDir, entry)
}

interface ResolvedTaskInput {
  tasksDir: string
  toolName: string
  subject: string
  toolInput: Record<string, any>
}

function resolveTaskInput(
  input: ReturnType<typeof toolHookInputSchema.parse>
): ResolvedTaskInput | null {
  const sessionId = resolveSafeSessionId(input.session_id)
  if (!sessionId) return null
  const subject = String(input.tool_input?.subject ?? "")
  if (!subject) return null
  const tasksDir = getSessionTasksDir(sessionId)
  if (!tasksDir) return null
  return {
    tasksDir,
    toolName: input.tool_name ?? "",
    subject,
    toolInput: (input.tool_input ?? {}) as Record<string, any>,
  }
}

async function dispatchTaskAudit(resolved: ResolvedTaskInput): Promise<void> {
  if (resolved.toolName === "TaskCreate") {
    await handleTaskCreate(resolved.tasksDir, resolved.subject)
  } else if (resolved.toolName === "TaskUpdate") {
    const taskId = String(resolved.toolInput.taskId ?? "")
    if (!taskId) return
    const newStatus = String(resolved.toolInput.status ?? "")
    await handleTaskUpdate(resolved.tasksDir, taskId, resolved.subject, newStatus)
  }
}

async function applyCreateEventState(
  sessionId: string,
  toolInput: Record<string, any>
): Promise<void> {
  const subject = String(toolInput.subject ?? "")
  if (!subject) return
  const tasksDir = getSessionTasksDir(sessionId)
  if (!tasksDir) return
  const taskId = await findLatestTaskId(tasksDir)
  if (taskId) {
    applyTaskCreateEvent(sessionId, taskId, subject)
  }
}

function applyUpdateEventState(sessionId: string, toolInput: Record<string, any>): void {
  const taskId = String(toolInput.taskId ?? toolInput.id ?? "")
  if (!taskId) return
  applyTaskUpdateEvent(sessionId, taskId, {
    status: toolInput.status ? String(toolInput.status) : undefined,
    subject: toolInput.subject ? String(toolInput.subject) : undefined,
  })
}

/**
 * Update in-memory event state so downstream hooks (e.g. task-count-context)
 * see post-mutation state without disk reads. Called for every task tool event.
 */
async function updateEventState(
  hookInput: ReturnType<typeof toolHookInputSchema.parse>
): Promise<void> {
  const sessionId = resolveSafeSessionId(hookInput.session_id)
  if (!sessionId) return

  const toolName = hookInput.tool_name ?? ""
  const toolInput = (hookInput.tool_input ?? {}) as Record<string, any>

  if (toolName === "TaskCreate") {
    await applyCreateEventState(sessionId, toolInput)
  } else if (toolName === "TaskUpdate" || toolName === "TodoWrite") {
    applyUpdateEventState(sessionId, toolInput)
  }
}

export async function evaluatePosttooluseTaskAuditSync(input: unknown): Promise<SwizHookOutput> {
  const hookInput = toolHookInputSchema.parse(input)
  const resolved = resolveTaskInput(hookInput)
  if (resolved) {
    await dispatchTaskAudit(resolved)
  }
  // Always update event state, even when audit log write is skipped
  // (e.g. TaskUpdate without subject — resolveTaskInput returns null but
  // event state still needs the status change)
  await updateEventState(hookInput)

  // Write-through to daemon's TaskStateCache — bypassed by local writeAuditEntry.
  const sessionId = resolveSafeSessionId(hookInput.session_id)
  if (sessionId) {
    const toolInput = (hookInput.tool_input ?? {}) as Record<string, unknown>
    const toolName = hookInput.tool_name ?? ""
    await applyCacheAuditWriteThrough(sessionId, toolName, toolInput)
  }

  return {}
}

export const taskAuditSyncHook: SwizHook<Record<string, any>> = {
  name: "posttooluse-task-audit-sync",
  event: "postToolUse",
  matcher: "TaskUpdate|TaskCreate|TodoWrite",
  timeout: 5,
  run(input) {
    return evaluatePosttooluseTaskAuditSync(input)
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// § 2. Task List Sync (TaskList)
// ═══════════════════════════════════════════════════════════════════════════

interface NormalizedTask {
  id: string
  subject: string
  status: string
}

function parseNormalizedTask(t: Record<string, any>): NormalizedTask | null {
  const id = t.id !== undefined && t.id !== null ? String(t.id) : ""
  const subject = typeof t.subject === "string" ? t.subject : ""
  const status = typeof t.status === "string" ? t.status : "pending"
  if (!id || !subject) return null
  return { id, subject, status }
}

function parseRawTasks(raw: PostToolHookInput["tool_response"]): unknown[] | null {
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

function parseToolResponse(raw: PostToolHookInput["tool_response"]): NormalizedTask[] {
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

interface SyncResult {
  created: number
  updated: number
  skipped: number
  /** All resolved SessionTask objects (written + unchanged) for cache write-through. */
  resolvedTasks: SessionTask[]
}

async function reconcileTasks(
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

// ─── List sync orchestration ────────────────────────────────────────────────

interface ResolvedListSyncInput {
  sessionId: string
  tasks: NormalizedTask[]
  tasksDir: string
  cwd: string
}

async function resolveListSyncInput(
  input: PostToolHookInput
): Promise<ResolvedListSyncInput | null> {
  if (input.tool_name !== "TaskList") return null
  const sessionId = resolveSafeSessionId(input.session_id)
  if (!sessionId) return null
  const tasks = parseToolResponse(input.tool_response)
  if (tasks.length === 0) return null
  const tasksDir = getSessionTasksDir(sessionId, homedir())
  if (!tasksDir) return null
  try {
    await mkdir(tasksDir, { recursive: true })
  } catch {
    return null
  }
  return { sessionId, tasks, tasksDir, cwd: input.cwd ?? process.cwd() }
}

function formatSyncSummary(
  counts: { created: number; updated: number; skipped: number },
  total: number
): string | null {
  if (counts.created === 0 && counts.updated === 0) return null
  const parts: string[] = []
  if (counts.created > 0) parts.push(`${counts.created} created`)
  if (counts.updated > 0) parts.push(`${counts.updated} updated`)
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`)
  return `TaskList sync: ${parts.join(", ")} (${total} task(s) in response).`
}

export async function evaluatePosttooluseTaskListSync(input: unknown): Promise<SwizHookOutput> {
  const hookInput = input as PostToolHookInput
  const resolved = await resolveListSyncInput(hookInput)
  if (!resolved) return {}

  // Update in-memory event state with the full task list from the response.
  // Downstream hooks in the same dispatch see this immediately without disk reads.
  applyTaskListEvent(
    resolved.sessionId,
    resolved.tasks.map((t) => ({ id: t.id, status: t.status, subject: t.subject }))
  )

  const syncResult = await reconcileTasks(resolved.tasks, homedir(), resolved.sessionId)

  // Write-through to the daemon's TaskStateCache so web UI and stop hooks
  // see the reconciled state immediately without waiting for fs.watch.
  if (syncResult.resolvedTasks.length > 0) {
    applyCacheTaskListSnapshot(resolved.sessionId, syncResult.resolvedTasks)
  }

  // Build count context from the reconciled task state so the model sees
  // task hygiene feedback (pending/in_progress warnings) after every TaskList.
  const countContext = buildCountSummaryFromTasks(resolved.tasks)

  const syncSummary = formatSyncSummary(syncResult, resolved.tasks.length)
  const combinedContext = [syncSummary, countContext].filter(Boolean).join("\n\n")
  if (!combinedContext) return {}

  return buildContextHookOutput("PostToolUse", combinedContext)
}

export const taskListSyncHook: SwizHook<PostToolHookInput> = {
  name: "posttooluse-task-list-sync",
  event: "postToolUse",
  matcher: "TaskList",
  timeout: 5,
  run(input) {
    return evaluatePosttooluseTaskListSync(input)
  },
}

// ═══════════════════════════════════════════════════════════════════════════
// § 3. Merged Task Sync — single entry point for all postToolUse task sync
// ═══════════════════════════════════════════════════════════════════════════

const posttooluseTaskSync: SwizHook<Record<string, any>> = {
  name: "posttooluse-task-sync",
  event: "postToolUse",
  timeout: 5,

  async run(input) {
    const rec = input as Record<string, any>
    const toolName = String(rec.tool_name ?? "")

    if (toolName === "TaskList") {
      return await evaluatePosttooluseTaskListSync(input)
    }

    if (toolName === "TaskUpdate" || toolName === "TaskCreate" || toolName === "TodoWrite") {
      return await evaluatePosttooluseTaskAuditSync(input)
    }

    return {}
  },
}

export default posttooluseTaskSync
