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
  toolNameForCurrentAgent,
} from "./utils/hook-utils.ts"
import { buildRecoveryStub, type TaskToolInput } from "./utils/task-hook-types.ts"

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

async function _writeRecoveryTask(
  tasksDir: string,
  taskPath: string,
  task: ReturnType<typeof buildRecoveryStub>
): Promise<boolean> {
  try {
    await mkdir(tasksDir, { recursive: true })
    await Bun.write(taskPath, JSON.stringify(task, null, 2))
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as TaskToolInput
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

  const task = buildRecoveryStub(taskId, {
    subject: input.tool_input?.subject,
    description: input.tool_input?.description,
    activeForm: input.tool_input?.activeForm,
    status: input.tool_input?.status ?? "completed",
    source: "posttooluse-task-recovery",
  })

  const wrote = await _writeRecoveryTask(tasksDir, taskPath, task)
  if (!wrote) {
    await emitContext(
      "PostToolUse",
      buildRecoveryErrorContext(taskId, task.subject, task.status),
      input.cwd
    )
    return
  }

  const successContext =
    `Task #${taskId} was missing (lost during context compaction) — automatically recovered. ` +
    `A replacement task file has been written with status '${task.status}' and subject: "${task.subject}". ` +
    `No further recovery action is needed. Continue with the next step.`

  await emitContext("PostToolUse", successContext, input.cwd)
}

if (import.meta.main) void main()
