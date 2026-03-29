#!/usr/bin/env bun

// PreToolUse hook: Enforce TaskUpdate tool instead of `swiz tasks` CLI in Claude Code.
// In Claude Code environment, prefer native task tools (TaskCreate, TaskUpdate, TaskGet, TaskList)
// over the swiz CLI equivalent. This improves task tracking and eliminates subprocess overhead.

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
import { type SessionTaskTipContext, sessionTaskToolPatterns } from "../src/utils/transcript.ts"

// Only enforce in agent/Claude Code context
const isClaudeCode = isRunningInAgent() || process.env.CLAUDECODE === "1"
let _cwd: string | undefined

interface SwizTasksRule {
  /** Regex to match this swiz tasks subcommand */
  match: (command: string) => boolean
  /** "deny" blocks the command. "warn" allows with a hint. Default: "deny". */
  severity?: "deny" | "warn"
  /** Human-readable guidance */
  message: string
  /** When set, omit tip if the current session transcript already shows this pattern */
  skipTipIf?: (ctx: SessionTaskTipContext) => boolean
  /** When true, block if completing this task would leave zero incomplete tasks */
  lastTaskGuard?: boolean
}

/**
 * Define rules for common `swiz tasks` subcommands.
 * Mutating operations are blocked; read operations are warned.
 */
function buildSwizTasksRules(): SwizTasksRule[] {
  return [
    {
      match: (c) => /swiz\s+tasks\s+(?:update|status)(?:\s|$)/.test(c),
      severity: "deny",
      message:
        "Use the TaskUpdate tool instead of `swiz tasks update/status`.\n\n" +
        "In Claude Code, use the native TaskUpdate tool for better integration:\n" +
        "  • TaskUpdate { taskId, status, description, ... }\n\n" +
        "The TaskUpdate tool is tracked, audited, and prevents subprocess overhead.\n\n" +
        "If you meant the CLI for scripting outside Claude Code, run the swiz command in a dedicated script.",
    },
    {
      match: (c) => /swiz\s+tasks\s+complete(?:\s|$)/.test(c),
      severity: "warn",
      skipTipIf: (ctx) => ctx.hasSwizCompleteWithEvidence || ctx.usedSwizTasksAddCreateStart,
      message:
        "Tip: Use the native TaskUpdate tool instead of `swiz tasks complete`.\n\n" +
        "In Claude Code, prefer TaskUpdate { taskId, status: 'completed' } for better integration.",
      lastTaskGuard: true,
    },
    {
      match: (c) => /swiz\s+tasks\s+(?:list|get)(?:\s|$)/.test(c),
      severity: "warn",
      skipTipIf: (ctx) => ctx.usedNativeTaskListOrGet || ctx.usedSwizTasksAddCreateStart,
      message:
        "Tip: Use the TaskList or TaskGet tool instead of `swiz tasks list/get`.\n\n" +
        "In Claude Code, prefer native task tools for better integration:\n" +
        "  • TaskList  — list all tasks\n" +
        "  • TaskGet   — fetch a specific task by ID\n\n" +
        "Native tools are tracked, audited, and eliminate subprocess overhead.",
    },
  ]
}

async function emitWarnAndAllow(
  rule: SwizTasksRule,
  sessionId: string,
  tipContext: SessionTaskTipContext
): Promise<never> {
  const skipTip = rule.skipTipIf?.(tipContext) ?? false
  const message = skipTip ? "" : rule.message
  if (sessionId && message) await scheduleAutoSteer(sessionId, message, undefined, _cwd)
  allowPreToolUse(message)
}

function shouldInspectShellInput(input: { tool_name?: string }): boolean {
  return isClaudeCode && isShellTool(input?.tool_name ?? "")
}

/** Extract task ID from `swiz tasks complete <id>` command */
function extractCompleteTaskId(command: string): string | null {
  const m = command.match(/swiz\s+tasks\s+complete\s+(\S+)/)
  return m?.[1] ?? null
}

/** Extract --session value from a `swiz tasks` command */
function extractTargetSession(command: string): string | null {
  const m = command.match(/--session\s+(\S+)/)
  return m?.[1] ?? null
}

async function checkLastTaskStanding(command: string, sessionId: string): Promise<void> {
  const taskId = extractCompleteTaskId(command)
  if (!taskId) return

  // Skip guard for cross-session completions — the target session is already ended,
  // so preventing it from reaching zero tasks serves no purpose. (Fixes #420)
  const targetSession = extractTargetSession(command)
  const safeId = resolveSafeSessionId(sessionId as string | undefined)
  if (
    targetSession &&
    safeId &&
    !safeId.startsWith(targetSession) &&
    !targetSession.startsWith(safeId)
  ) {
    return
  }

  if (!safeId) return
  const allTasks = await readSessionTasks(safeId)
  const error = validateLastTaskStanding(taskId, allTasks)
  if (error) {
    const taskId = extractCompleteTaskId(command)
    denyPreToolUse(buildLastTaskStandingDenial(taskId ?? "unknown"))
  }
}

async function checkRules(
  command: string,
  rules: SwizTasksRule[],
  sessionId: string,
  tipContext: SessionTaskTipContext
): Promise<void> {
  for (const rule of rules) {
    if (!rule.match(command)) continue

    // Last-task-standing guard: block if completing would leave zero incomplete tasks
    if (rule.lastTaskGuard) {
      await checkLastTaskStanding(command, sessionId)
    }

    if (rule.severity === "warn") {
      await emitWarnAndAllow(rule, sessionId, tipContext)
    } else {
      // For deny rules: if auto-steer can handle it, allow + steer instead
      if (sessionId && (await scheduleAutoSteer(sessionId, rule.message, undefined, _cwd))) {
        allowPreToolUse(rule.message)
      }
      denyPreToolUse(rule.message)
    }
  }

  // No rules matched — allow the command
  allowPreToolUse("")
}

async function runSwizTasksEnforcement(input: Record<string, unknown>): Promise<void> {
  const command = String((input.tool_input as Record<string, unknown> | undefined)?.command ?? "")
  const sessionId = String(input.session_id ?? "")
  const transcriptPath = String(input.transcript_path ?? "")
  _cwd = (input.cwd as string) ?? undefined
  const tipContext = await sessionTaskToolPatterns(transcriptPath)
  await checkRules(command, buildSwizTasksRules(), sessionId, tipContext)
}

async function main() {
  const input = await Bun.stdin.json()
  if (!shouldInspectShellInput(input)) process.exit(0)
  await runSwizTasksEnforcement(input as Record<string, unknown>)
}

if (import.meta.main) {
  void main()
}
