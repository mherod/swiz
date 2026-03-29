#!/usr/bin/env bun

// PreToolUse hook: Block `swiz tasks` CLI in Claude Code; native task tools only.
// TaskCreate, TaskUpdate, TaskList, and TaskGet are the supported channel.

import { readSessionTasks } from "../src/tasks/task-recovery.ts"
import { validateLastTaskStanding } from "../src/tasks/task-service.ts"
import {
  allowPreToolUse,
  buildLastTaskStandingDenial,
  denyPreToolUse,
  isRunningInAgent,
  isShellTool,
  resolveSafeSessionId,
  scheduleAutoSteer,
} from "../src/utils/hook-utils.ts"
import { shellTokenCommandRe, stripQuotedShellStrings } from "../src/utils/shell-patterns.ts"

// Only enforce in agent/Claude Code context
const isClaudeCode = isRunningInAgent() || process.env.CLAUDECODE === "1"
let _cwd: string | undefined

const SWIZ_TASKS_CLI_RE = shellTokenCommandRe(String.raw`swiz\s+tasks(?:\s|$)`)
const SWIZ_TASKS_ADOPT_RE = shellTokenCommandRe(String.raw`swiz\s+tasks\s+adopt(?:\s|$)`)

const SWIZ_TASKS_CLI_DENY_MESSAGE =
  "Do not use the `swiz tasks` CLI inside Claude Code.\n\n" +
  "Use native task tools only:\n" +
  "  • TaskCreate — new tasks\n" +
  "  • TaskUpdate — status, subject, description, and marking completed\n" +
  "  • TaskList / TaskGet — query tasks\n\n" +
  "Work must stay in the tracked tool channel (auditing, hooks, and task sync depend on it).\n\n" +
  "The only `swiz tasks` subcommand still allowed here is `adopt` (orphan recovery after compaction)."

function shouldInspectShellInput(input: { tool_name?: string }): boolean {
  return isClaudeCode && isShellTool(input?.tool_name ?? "")
}

/** True when Bash runs swiz tasks, except `swiz tasks adopt`. */
function isBlockedSwizTasksCliCommand(command: string): boolean {
  const stripped = stripQuotedShellStrings(command)
  if (!SWIZ_TASKS_CLI_RE.test(stripped)) return false
  if (SWIZ_TASKS_ADOPT_RE.test(stripped)) return false
  return true
}

/** Shared guard: read tasks, validate, deny if last standing. */
async function denyIfLastTaskStanding(taskId: string, sessionId: string): Promise<void> {
  const allTasks = await readSessionTasks(sessionId)
  const error = validateLastTaskStanding(taskId, allTasks)
  if (error) {
    denyPreToolUse(buildLastTaskStandingDenial(taskId))
  }
}

async function runSwizTasksEnforcement(input: Record<string, unknown>): Promise<void> {
  const command = String((input.tool_input as Record<string, unknown> | undefined)?.command ?? "")
  const sessionId = String(input.session_id ?? "")
  _cwd = (input.cwd as string) ?? undefined

  if (!isBlockedSwizTasksCliCommand(command)) {
    allowPreToolUse("")
  }

  if (
    sessionId &&
    (await scheduleAutoSteer(sessionId, SWIZ_TASKS_CLI_DENY_MESSAGE, undefined, _cwd))
  ) {
    allowPreToolUse(SWIZ_TASKS_CLI_DENY_MESSAGE)
  }
  denyPreToolUse(SWIZ_TASKS_CLI_DENY_MESSAGE)
}

async function checkNativeTaskUpdateCompletion(input: Record<string, unknown>): Promise<void> {
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>
  if (toolInput.status !== "completed") process.exit(0)

  const taskId = String(toolInput.taskId ?? "")
  if (!taskId) process.exit(0)

  const sessionId = resolveSafeSessionId(input.session_id as string | undefined)
  if (!sessionId) process.exit(0)

  await denyIfLastTaskStanding(taskId, sessionId)
  allowPreToolUse("")
}

function isNativeTaskTool(toolName: string): boolean {
  return toolName === "TaskUpdate" || toolName === "update_plan"
}

async function main() {
  const input = await Bun.stdin.json()
  const toolName = String(input?.tool_name ?? "")

  if (isNativeTaskTool(toolName)) {
    await checkNativeTaskUpdateCompletion(input as Record<string, unknown>)
  }

  if (!shouldInspectShellInput(input)) process.exit(0)
  await runSwizTasksEnforcement(input as Record<string, unknown>)
}

if (import.meta.main) {
  void main()
}
