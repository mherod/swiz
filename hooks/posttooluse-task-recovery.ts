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

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as ExtendedToolInput
  if (!input.session_id) return

  const toolName = input.tool_name ?? ""
  if (!isTaskTool(toolName)) return

  // Only act on tools that reference an existing task by ID
  const taskId = String(input.tool_input?.taskId ?? "")
  if (!taskId) return

  // TaskCreate doesn't reference existing IDs — skip it
  if (toolName === "TaskCreate") return

  const home = homedir()
  const tasksDir = getSessionTasksDir(input.session_id, home)
  const taskPath = getSessionTaskPath(input.session_id, taskId, home)
  if (!tasksDir || !taskPath) return
  const taskExists = await Bun.file(taskPath).exists()
  if (taskExists) return

  // ── Auto-recovery ──────────────────────────────────────────────────────────
  // The task is missing. Apply the requested status immediately by writing
  // the file directly rather than asking the agent to recreate it.

  const requestedStatus = input.tool_input?.status ?? "completed"
  const requestedSubject =
    input.tool_input?.subject ?? `Recovered task #${taskId} (lost during compaction)`
  const requestedDescription =
    input.tool_input?.description ??
    `This task was automatically recovered by posttooluse-task-recovery after task #${taskId} was not found on disk. The requested status '${requestedStatus}' has been applied.`
  const requestedActiveForm = input.tool_input?.activeForm

  // Only valid statuses
  const validStatuses = ["pending", "in_progress", "completed"]
  const status = validStatuses.includes(requestedStatus) ? requestedStatus : "completed"

  const task: TaskFile = {
    id: taskId,
    subject: requestedSubject,
    description: requestedDescription,
    ...(requestedActiveForm ? { activeForm: requestedActiveForm } : {}),
    status,
    blocks: [],
    blockedBy: [],
  }

  try {
    await mkdir(tasksDir, { recursive: true })
    await Bun.write(taskPath, JSON.stringify(task, null, 2))
  } catch {
    const taskCreateName = toolNameForCurrentAgent("TaskCreate")
    const taskUpdateName = toolNameForCurrentAgent("TaskUpdate")
    // If write fails, fall back to advisory text so the agent knows to act
    const context = [
      `Task #${taskId} not found on disk — auto-recovery write failed.`,
      `Recovery steps:`,
      `1. Use ${taskCreateName} to recreate task #${taskId} with subject: "${requestedSubject}"`,
      `2. Mark it ${status} with ${taskUpdateName} immediately.`,
      "Do NOT ignore this — untracked work causes stop hook failures.",
    ].join(" ")

    emitContext("PostToolUse", context, input.cwd)
  }

  // Confirm success to the agent — no further action needed
  const successContext =
    `Task #${taskId} was missing (lost during context compaction) — automatically recovered. ` +
    `A replacement task file has been written with status '${status}' and subject: "${requestedSubject}". ` +
    `No further recovery action is needed. Continue with the next step.`

  emitContext("PostToolUse", successContext, input.cwd)
}

main()
