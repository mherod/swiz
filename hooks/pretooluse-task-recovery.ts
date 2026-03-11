#!/usr/bin/env bun
/**
 * PreToolUse hook: Create missing task stubs before TaskUpdate/TaskGet runs.
 *
 * When a task ID is missing on disk (lost during context compaction), this hook
 * creates a minimal stub file BEFORE the tool executes — so TaskUpdate finds
 * the file, applies the requested status change, and returns success. The agent
 * never sees "Task not found". Recovery is fully transparent.
 *
 * The PostToolUse hook (posttooluse-task-recovery.ts) acts as a safety net for
 * any cases this hook misses (e.g. different session context), but with this
 * PreToolUse in place the PostToolUse recovery path should rarely trigger.
 */

import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import {
  getSessionTaskPath,
  getSessionTasksDir,
  isTaskTool,
  resolveSafeSessionId,
  type ToolHookInput,
} from "./hook-utils.ts"

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

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as ExtendedToolInput
  const sessionId = resolveSafeSessionId(input.session_id)
  if (!sessionId) return

  const toolName = input.tool_name ?? ""
  if (!isTaskTool(toolName)) return

  // Only act on tools that reference an existing task by ID
  const taskId = String(input.tool_input?.taskId ?? "")
  if (!taskId) return

  // TaskCreate doesn't reference existing IDs — skip it
  if (toolName === "TaskCreate") return

  const home = homedir()
  const tasksDir = getSessionTasksDir(sessionId, home)
  const taskFile = getSessionTaskPath(sessionId, taskId, home)
  if (!tasksDir || !taskFile) return

  // Check if the task already exists — if so, nothing to do
  if (await Bun.file(taskFile).exists()) return

  // Build a stub task. Use "in_progress" as the initial status so TaskUpdate
  // can transition it to whatever the agent requested (typically "completed").
  const nowIso = new Date().toISOString()
  const nowMs = Date.now()
  const stub: TaskFile = {
    id: taskId,
    subject: `Recovered task #${taskId} (lost during compaction)`,
    description:
      `This task was automatically recovered by pretooluse-task-recovery ` +
      `before task #${taskId} was referenced. The original task content was lost ` +
      `during context compaction. Status will be updated by the triggering tool call.`,
    status: "in_progress",
    blocks: [],
    blockedBy: [],
    statusChangedAt: nowIso,
    elapsedMs: 0,
    startedAt: nowMs,
    completedAt: null,
  }

  try {
    await mkdir(tasksDir, { recursive: true })
    await Bun.write(taskFile, JSON.stringify(stub, null, 2))
  } catch {
    // Write failed — fall through silently. The PostToolUse hook will catch the
    // resulting "Task not found" error and provide advisory recovery guidance.
  }

  // Exit 0 with no output — implicit allow. TaskUpdate/TaskGet will now find
  // the stub file and succeed. The agent receives a transparent recovery.
}

if (import.meta.main) main()
