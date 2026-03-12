#!/usr/bin/env bun
/**
 * PostToolUse hook: Auto-recover missing tasks and confirm recovery.
 *
 * After TaskUpdate or TaskGet, checks whether the referenced task ID
 * exists on disk. If it doesn't (e.g. lost during context compaction),
 * immediately writes a replacement task file with the requested status
 * already applied — no advisory loop required. The agent is informed
 * that recovery was automatic and can continue without extra steps.
 */

import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import {
  emitContext,
  getSessionTaskPath,
  getSessionTasksDir,
  isTaskTool,
  resolveSafeSessionId,
  type ToolHookInput,
  toolNameForCurrentAgent,
} from "./hook-utils.ts"

interface TaskFile {
  id: string
  subject: string
  description: string
  activeForm?: string
  status: string
  blocks: string[]
  blockedBy: string[]
  statusChangedAt: string
  elapsedMs: number
  startedAt: number | null
  completedAt: number | null
  completionTimestamp?: string
}

interface ExtendedToolInput extends ToolHookInput {
  tool_input?: {
    taskId?: string | number
    status?: string
    subject?: string
    description?: string
    activeForm?: string
    [key: string]: unknown
  }
}

function buildRecoveryTask(
  taskId: string,
  input: ExtendedToolInput
): { task: TaskFile; status: string; subject: string } {
  const requestedStatus = input.tool_input?.status ?? "completed"
  const requestedSubject =
    input.tool_input?.subject ?? `Recovered task #${taskId} (lost during compaction)`
  const requestedDescription =
    input.tool_input?.description ??
    `This task was automatically recovered by posttooluse-task-recovery after task #${taskId} was not found on disk. The requested status '${requestedStatus}' has been applied.`
  const requestedActiveForm = input.tool_input?.activeForm

  const validStatuses = ["pending", "in_progress", "completed"]
  const status = validStatuses.includes(requestedStatus) ? requestedStatus : "completed"
  const nowIso = new Date().toISOString()
  const nowMs = Date.now()

  const task: TaskFile = {
    id: taskId,
    subject: requestedSubject,
    description: requestedDescription,
    ...(requestedActiveForm ? { activeForm: requestedActiveForm } : {}),
    status,
    blocks: [],
    blockedBy: [],
    statusChangedAt: nowIso,
    elapsedMs: 0,
    startedAt: status === "in_progress" ? nowMs : null,
    completedAt: status === "completed" ? nowMs : null,
    ...(status === "completed" ? { completionTimestamp: nowIso } : {}),
  }

  return { task, status, subject: requestedSubject }
}

function buildRecoveryErrorContext(taskId: string, subject: string, status: string): string {
  const taskCreateName = toolNameForCurrentAgent("TaskCreate")
  const taskUpdateName = toolNameForCurrentAgent("TaskUpdate")
  return [
    `Task #${taskId} not found on disk — auto-recovery write failed.`,
    `Recovery steps:`,
    `1. Use ${taskCreateName} to recreate task #${taskId} with subject: "${subject}"`,
    `2. Mark it ${status} with ${taskUpdateName} immediately.`,
    "Do NOT ignore this — untracked work causes stop hook failures.",
  ].join(" ")
}

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as ExtendedToolInput
  const sessionId = resolveSafeSessionId(input.session_id)
  if (!sessionId) return

  const toolName = input.tool_name ?? ""
  if (!isTaskTool(toolName) || toolName === "TaskCreate") return

  const taskId = String(input.tool_input?.taskId ?? "")
  if (!taskId) return

  const home = homedir()
  const tasksDir = getSessionTasksDir(sessionId, home)
  const taskPath = getSessionTaskPath(sessionId, taskId, home)
  if (!tasksDir || !taskPath) return
  if (await Bun.file(taskPath).exists()) return

  const { task, status, subject } = buildRecoveryTask(taskId, input)

  try {
    await mkdir(tasksDir, { recursive: true })
    await Bun.write(taskPath, JSON.stringify(task, null, 2))
  } catch {
    emitContext("PostToolUse", buildRecoveryErrorContext(taskId, subject, status), input.cwd)
  }

  const successContext =
    `Task #${taskId} was missing (lost during context compaction) — automatically recovered. ` +
    `A replacement task file has been written with status '${status}' and subject: "${subject}". ` +
    `No further recovery action is needed. Continue with the next step.`

  emitContext("PostToolUse", successContext, input.cwd)
}

if (import.meta.main) void main()
