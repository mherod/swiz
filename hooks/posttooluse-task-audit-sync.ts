#!/usr/bin/env bun

/**
 * PostToolUse hook: Sync native TaskCreate/TaskUpdate metadata to swiz audit log.
 *
 * Claude's native TaskCreate writes task files to ~/.claude/tasks/<session-id>/,
 * but these files can become orphaned during context compaction when the session
 * ID changes. This hook writes audit log entries so that
 * `recoverSubjectFromAuditLogs` in task-service.ts can recover original task
 * subjects instead of creating placeholder stubs.
 *
 * Fires after TaskCreate and TaskUpdate — captures subject and status changes
 * for every native task tool call.
 */

import { appendFile, mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { buildContextHookOutput, runSwizHookAsMain } from "../src/SwizHook.ts"
import { resolveSafeSessionId } from "../src/session-id.ts"
import { formatTaskList, getSessionTasksDir } from "../src/tasks/task-recovery.ts"
import { readTasks } from "../src/tasks/task-repository.ts"
import { toolHookInputSchema } from "./schemas.ts"

interface AuditEntry {
  timestamp: string
  taskId: string
  action: "create" | "status_change"
  oldStatus?: string
  newStatus?: string
  subject?: string
  source: "native-tool-sync"
}

/**
 * Find the most recently created task file in the session directory.
 * Returns the task ID (filename without .json) or null.
 */
async function findLatestTaskId(tasksDir: string): Promise<string | null> {
  let files: string[]
  try {
    files = await readdir(tasksDir)
  } catch {
    return null
  }

  let maxId = -1
  for (const f of files) {
    if (!f.endsWith(".json") || f.startsWith(".")) continue
    const id = Number.parseInt(f.replace(".json", ""), 10)
    if (!Number.isNaN(id) && id > maxId) maxId = id
  }
  return maxId >= 0 ? String(maxId) : null
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
  sessionId: string
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
  const tasksDir = getSessionTasksDir(sessionId)
  if (!tasksDir) return null
  return {
    sessionId,
    tasksDir,
    toolName: input.tool_name ?? "",
    subject: String(input.tool_input?.subject ?? ""),
    toolInput: (input.tool_input ?? {}) as Record<string, any>,
  }
}

async function dispatchTaskAudit(resolved: ResolvedTaskInput): Promise<void> {
  if (resolved.toolName === "TaskCreate") {
    if (resolved.subject) await handleTaskCreate(resolved.tasksDir, resolved.subject)
  } else if (resolved.toolName === "TaskUpdate") {
    const taskId = String(resolved.toolInput.taskId ?? "")
    if (!taskId) return
    const newStatus = String(resolved.toolInput.status ?? "")
    await handleTaskUpdate(resolved.tasksDir, taskId, resolved.subject, newStatus)
  }
}

export async function evaluatePosttooluseTaskAuditSync(input: unknown): Promise<SwizHookOutput> {
  const hookInput = toolHookInputSchema.parse(input)
  const resolved = resolveTaskInput(hookInput)
  if (!resolved) return {}
  await dispatchTaskAudit(resolved)

  const tasks = await readTasks(resolved.sessionId)
  if (tasks.length === 0) return {}

  const taskList = formatTaskList(
    tasks.map((t) => ({ id: t.id, status: t.status, subject: t.subject })),
    { indent: "" }
  )
  if (!taskList) return {}

  return buildContextHookOutput("PostToolUse", `Current tasks:\n${taskList}`)
}

const posttooluseTaskAuditSync: SwizHook<Record<string, any>> = {
  name: "posttooluse-task-audit-sync",
  event: "postToolUse",
  matcher: "TaskUpdate|TaskCreate|TodoWrite",
  timeout: 5,
  run(input) {
    return evaluatePosttooluseTaskAuditSync(input)
  },
}

export default posttooluseTaskAuditSync

if (import.meta.main) {
  await runSwizHookAsMain(posttooluseTaskAuditSync)
}
