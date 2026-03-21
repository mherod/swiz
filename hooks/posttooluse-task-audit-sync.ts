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
import { toolHookInputSchema } from "./schemas.ts"
import { getSessionTasksDir, resolveSafeSessionId } from "./utils/hook-utils.ts"

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

async function main(): Promise<void> {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())
  const sessionId = resolveSafeSessionId(input.session_id)
  if (!sessionId) return

  const toolName = input.tool_name ?? ""
  const subject = String(input.tool_input?.subject ?? "")
  if (!subject) return

  const tasksDir = getSessionTasksDir(sessionId)
  if (!tasksDir) return

  if (toolName === "TaskCreate") {
    // Find the task ID by reading the most recently created file in the session dir.
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
  } else if (toolName === "TaskUpdate") {
    const taskId = String(input.tool_input?.taskId ?? "")
    if (!taskId) return

    const newStatus = String(input.tool_input?.status ?? "")
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
}

if (import.meta.main) void main()
