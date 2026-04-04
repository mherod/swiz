#!/usr/bin/env bun

// PreToolUse hook: Block `swiz tasks` CLI in Claude Code; native task tools only.
// TaskCreate, TaskUpdate, TaskList, and TaskGet are the supported channel.
//
// Dual-mode: SwizToolHook + runSwizHookAsMain.

import type { SwizHookOutput, SwizToolHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { readSessionTasks } from "../src/tasks/task-recovery.ts"
import { isGitWorkingTreeClean, validateLastTaskStanding } from "../src/tasks/task-service.ts"
import {
  buildLastTaskStandingDenial,
  isRunningInAgent,
  isShellTool,
  preToolUseAllow,
  preToolUseDeny,
  resolveSafeSessionId,
  scheduleAutoSteer,
} from "../src/utils/hook-utils.ts"
import { shellTokenCommandRe, stripQuotedShellStrings } from "../src/utils/shell-patterns.ts"
import { toolHookInputSchema } from "./schemas.ts"

const isClaudeCode = isRunningInAgent() || process.env.CLAUDECODE === "1"

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

function isBlockedSwizTasksCliCommand(command: string): boolean {
  const stripped = stripQuotedShellStrings(command)
  if (!SWIZ_TASKS_CLI_RE.test(stripped)) return false
  return !SWIZ_TASKS_ADOPT_RE.test(stripped)
}

async function denyIfLastTaskStanding(
  taskId: string,
  sessionId: string,
  cwd?: string
): Promise<SwizHookOutput | null> {
  const allTasks = await readSessionTasks(sessionId)
  const repoClean = isGitWorkingTreeClean(cwd)
  const error = validateLastTaskStanding(taskId, allTasks, { repoClean })
  if (error) {
    return preToolUseDeny(await buildLastTaskStandingDenial(taskId, cwd))
  }
  return null
}

async function runSwizTasksEnforcement(input: Record<string, any>): Promise<SwizHookOutput> {
  const command = String((input.tool_input as Record<string, any> | undefined)?.command ?? "")
  const sessionId = String(input.session_id ?? "")
  const cwd = (input.cwd as string) ?? undefined

  if (!isBlockedSwizTasksCliCommand(command)) {
    return preToolUseAllow("")
  }

  if (
    sessionId &&
    (await scheduleAutoSteer(sessionId, SWIZ_TASKS_CLI_DENY_MESSAGE, undefined, cwd))
  ) {
    return preToolUseAllow(SWIZ_TASKS_CLI_DENY_MESSAGE)
  }
  return preToolUseDeny(SWIZ_TASKS_CLI_DENY_MESSAGE)
}

type NativeTaskUpdateResult = SwizHookOutput | "early_exit" | "continue"

// ─── Sliding-window completion rate limiter ─────────────────────────────────
// Thresholds: 2 completions in 3s is fine. 3 in 5s is the top threshold.
// 4+ in 5s triggers a hard cooldown block.

const WINDOW_MS = 5_000
const MAX_COMPLETIONS_IN_WINDOW = 2

/** Per-session ring buffer of recent completion timestamps. */
const completionTimestamps = new Map<string, number[]>()

function pruneWindow(timestamps: number[], now: number): number[] {
  const cutoff = now - WINDOW_MS
  return timestamps.filter((t) => t > cutoff)
}

function checkCompletionRateLimit(sessionId: string): SwizHookOutput | null {
  const now = Date.now()
  const existing = completionTimestamps.get(sessionId) ?? []
  const recent = pruneWindow(existing, now)

  if (recent.length >= MAX_COMPLETIONS_IN_WINDOW) {
    // Don't record this attempt — the agent must wait
    completionTimestamps.set(sessionId, recent)
    const oldestInWindow = recent[0] ?? now
    const waitSec = Math.ceil((oldestInWindow + WINDOW_MS - now) / 1000)
    return preToolUseDeny(
      `Task completion rate limit: ${recent.length} completions in the last 5 seconds exceeds the threshold (max ${MAX_COMPLETIONS_IN_WINDOW}).\n\n` +
        `Wait ${waitSec}s before completing another task.\n\n` +
        "Before retrying, you MUST:\n" +
        "1. Run TaskList to review the current task state\n" +
        "2. Verify each task you intend to complete has concrete evidence (commit SHA, test output, file path)\n" +
        "3. Confirm the work described in the task subject has actually been done — not assumed, not deferred\n" +
        "4. Complete ONE task at a time, waiting for this hook to clear between each\n\n" +
        "Rapid-fire completions bypass governance checks and risk leaving work unfinished."
    )
  }

  // Record this completion
  recent.push(now)
  completionTimestamps.set(sessionId, recent)
  return null
}

async function checkNativeTaskUpdateCompletion(
  input: Record<string, any>
): Promise<NativeTaskUpdateResult> {
  const toolInput = (input.tool_input ?? {}) as Record<string, any>
  if (toolInput.status !== "completed") return "early_exit"

  const taskId = String(toolInput.taskId ?? "")
  if (!taskId) return "early_exit"

  const sessionId = resolveSafeSessionId(input.session_id as string | undefined)
  if (!sessionId) return "early_exit"

  // Rate limit: block completions that happen too quickly in succession
  const rateLimited = checkCompletionRateLimit(sessionId)
  if (rateLimited) return rateLimited

  const cwd = (input.cwd as string) ?? undefined
  const denied = await denyIfLastTaskStanding(taskId, sessionId, cwd)
  if (denied) return denied
  return "continue"
}

function isNativeTaskTool(toolName: string): boolean {
  return toolName === "TaskUpdate" || toolName === "update_plan"
}

export async function evaluatePretooluseEnforceTaskupdate(input: unknown): Promise<SwizHookOutput> {
  const parsed = toolHookInputSchema.parse(input)
  const rec = parsed as unknown as Record<string, any>
  const toolName = String(rec.tool_name ?? "")

  if (isNativeTaskTool(toolName)) {
    const n = await checkNativeTaskUpdateCompletion(rec)
    if (n === "early_exit") return {}
    if (n !== "continue") return n
  }

  if (!shouldInspectShellInput(parsed)) return {}

  return await runSwizTasksEnforcement(rec)
}

const pretooluseEnforceTaskupdate: SwizToolHook = {
  name: "pretooluse-enforce-taskupdate",
  event: "preToolUse",
  timeout: 5,

  run(input) {
    return evaluatePretooluseEnforceTaskupdate(input)
  },
}

export default pretooluseEnforceTaskupdate

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseEnforceTaskupdate)
}
