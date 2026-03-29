#!/usr/bin/env bun
/**
 * PostToolUse hook: Auto-complete Commit/Push tasks after git operations
 *
 * After a successful `git commit` or `git push` Bash call, scans the session's
 * task files and marks any pending/in_progress task whose subject contains
 * "Commit" or "Push" (case-insensitive) as completed.
 *
 * After a push, emits additionalContext reminding the agent to create the next
 * workflow task (either CI follow-through or PR creation, depending on
 * settings) — the only way to affect Claude's in-memory task list is via the
 * hook output channel, not filesystem writes.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { getEffectiveSwizSettings, readProjectSettings, readSwizSettings } from "../src/settings.ts"
import { validateTransition } from "../src/tasks/task-service.ts"
import {
  autoTransitionForComplete,
  emitContext,
  GIT_COMMIT_RE,
  GIT_PUSH_RE,
  getSessionTasksDir,
  isShellTool,
  isTerminalTaskStatus,
  readSessionTasks,
  resolveSafeSessionId,
  stripHeredocs,
  toolNameForCurrentAgent,
} from "../src/utils/hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

const SUBJECT_RE = /\b(commit|push)\b/i

function shouldCompleteTask(
  task: { status: string; subject: string },
  isCommit: boolean,
  isPush: boolean
): boolean {
  if (isTerminalTaskStatus(task.status)) return false
  if (!SUBJECT_RE.test(task.subject)) return false
  const subjectLower = task.subject.toLowerCase()
  return (isPush && subjectLower.includes("push")) || (isCommit && subjectLower.includes("commit"))
}

async function completeTasks(
  tasksDir: string,
  tasks: Array<{ id: string; status: string; subject: string }>,
  isCommit: boolean,
  isPush: boolean
): Promise<void> {
  for (const task of tasks) {
    if (!shouldCompleteTask(task, isCommit, isPush)) continue
    autoTransitionForComplete(task)
    if (validateTransition(task.status, "completed")) continue
    task.status = "completed"
    await Bun.write(join(tasksDir, `${task.id}.json`), JSON.stringify(task, null, 2))
  }
}

async function buildPushContext(sessionId: string, cwd: string): Promise<string> {
  const taskCreateName = toolNameForCurrentAgent("TaskCreate")
  const settings = await readSwizSettings()
  const projectSettings = await readProjectSettings(cwd)
  const effective = getEffectiveSwizSettings(settings, sessionId, projectSettings)
  if (effective.ignoreCi) {
    return "git push succeeded."
  }
  if (projectSettings?.trunkMode) {
    return `git push succeeded. Trunk mode — no pull request. Use ${taskCreateName} to add a "Wait for CI and verify pass" task if your workflow needs it, then mark it in_progress before stopping.`
  }
  return effective.prMergeMode
    ? `git push succeeded. Use ${taskCreateName} to create a "Wait for CI and verify pass" task, then mark it in_progress and monitor CI before stopping.`
    : `git push succeeded. Use ${taskCreateName} to create an "Open PR for this branch" task, then mark it in_progress and open the pull request before stopping.`
}

function resolveGitOp(
  input: ReturnType<typeof toolHookInputSchema.parse>
): { sessionId: string; isCommit: boolean; isPush: boolean } | null {
  const sessionId = resolveSafeSessionId(input.session_id)
  if (!sessionId) return null
  if (!input.tool_name || !isShellTool(input.tool_name)) return null
  const command = stripHeredocs(String(input.tool_input?.command ?? ""))
  const isCommit = GIT_COMMIT_RE.test(command)
  const isPush = GIT_PUSH_RE.test(command)
  if (!isCommit && !isPush) return null
  return { sessionId, isCommit, isPush }
}

async function main(): Promise<void> {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())
  const op = resolveGitOp(input)
  if (!op) return

  const home = homedir()
  const tasksDir = getSessionTasksDir(op.sessionId, home)
  if (!tasksDir) return
  const tasks = await readSessionTasks(op.sessionId, home)

  await completeTasks(tasksDir, tasks, op.isCommit, op.isPush)

  if (op.isPush) {
    const cwd = input.cwd ?? process.cwd()
    await emitContext("PostToolUse", await buildPushContext(op.sessionId, cwd), cwd)
  }
}

if (import.meta.main) void main()
