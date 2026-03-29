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
import { getSessionTasksDir } from "../src/tasks/task-recovery.ts"
import { resolveSafeSessionId } from "../src/utils/hook-utils.ts"
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
  tasksDir: string
  toolName: string
  subject: string
  toolInput: Record<string, unknown>
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
    toolInput: (input.tool_input ?? {}) as Record<string, unknown>,
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

async function main(): Promise<void> {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())
  const resolved = resolveTaskInput(input)
  if (!resolved) return
  await dispatchTaskAudit(resolved)
}

if (import.meta.main) void main()
