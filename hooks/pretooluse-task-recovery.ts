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
} from "./utils/hook-utils.ts"
import { buildRecoveryStub, type TaskToolInput } from "./utils/task-hook-types.ts"

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as TaskToolInput
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

  const stub = buildRecoveryStub(taskId, { source: "pretooluse-task-recovery" })

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

if (import.meta.main) void main()
