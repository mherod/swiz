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

interface RecoveryContext {
  sessionId: string
  taskId: string
  toolName: string
  input: TaskToolInput
  tasksDir: string
  taskPath: string
}

function tryBuildRecoveryContext(input: TaskToolInput, home: string): RecoveryContext | null {
  const sessionId = resolveSafeSessionId(input.session_id)
  if (!sessionId) return null

  const toolName = input.tool_name ?? ""
  if (!isTaskTool(toolName) || toolName === "TaskCreate") return null

  const taskId = String(input.tool_input?.taskId ?? "")
  if (!taskId) return null

  const tasksDir = getSessionTasksDir(sessionId, home)
  const taskPath = getSessionTaskPath(sessionId, taskId, home)
  if (!tasksDir || !taskPath) return null

  return { sessionId, taskId, toolName, input, tasksDir, taskPath }
}

async function recoverMissingTask(ctx: RecoveryContext): Promise<void> {
  if (await Bun.file(ctx.taskPath).exists()) return

  const task = buildRecoveryStub(ctx.taskId, {
    subject: ctx.input.tool_input?.subject,
    description: ctx.input.tool_input?.description,
    activeForm: ctx.input.tool_input?.activeForm,
    status: ctx.input.tool_input?.status ?? "completed",
    source: "posttooluse-task-recovery",
  })

  const wrote = await _writeRecoveryTask(ctx.tasksDir, ctx.taskPath, task)
  if (!wrote) {
    await emitContext(
      "PostToolUse",
      buildRecoveryErrorContext(ctx.taskId, task.subject, task.status),
      ctx.input.cwd
    )
    return
  }

  const successContext =
    `Task #${ctx.taskId} was missing (lost during context compaction) — automatically recovered. ` +
    `A replacement task file has been written with status '${task.status}' and subject: "${task.subject}". ` +
    `No further recovery action is needed. Continue with the next step.`

  await emitContext("PostToolUse", successContext, ctx.input.cwd)
}

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as TaskToolInput
  const home = homedir()
  const ctx = tryBuildRecoveryContext(input, home)
  if (!ctx) return
  await recoverMissingTask(ctx)
}

if (import.meta.main) void main()
