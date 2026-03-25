#!/usr/bin/env bun
// PreToolUse hook: Enforce TaskUpdate tool instead of `swiz tasks` CLI in Claude Code.
// In Claude Code environment, prefer native task tools (TaskCreate, TaskUpdate, TaskGet, TaskList)
// over the swiz CLI equivalent. This improves task tracking and eliminates subprocess overhead.

import {
  allowPreToolUse,
  denyPreToolUse,
  isRunningInAgent,
  isShellTool,
  scheduleAutoSteer,
} from "./utils/hook-utils.ts"
import { type SessionTaskTipContext, sessionTaskToolPatterns } from "./utils/transcript.ts"

// Only enforce in agent/Claude Code context
const isClaudeCode = isRunningInAgent() || process.env.CLAUDECODE === "1"

interface SwizTasksRule {
  /** Regex to match this swiz tasks subcommand */
  match: (command: string) => boolean
  /** "deny" blocks the command. "warn" allows with a hint. Default: "deny". */
  severity?: "deny" | "warn"
  /** Human-readable guidance */
  message: string
  /** When set, omit tip if the current session transcript already shows this pattern */
  skipTipIf?: (ctx: SessionTaskTipContext) => boolean
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
        "Tip: `swiz tasks complete` is the correct command for task completion with evidence.\n\n" +
        "Ensure you include structured evidence:\n" +
        "  • swiz tasks complete <id> --evidence 'note:task done'\n" +
        "  • swiz tasks complete <id> --evidence 'commit:abc123'\n\n" +
        "Supported evidence types: commit, pr, file, test, note, ci_green, conclusion, run.",
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
  if (sessionId && message) await scheduleAutoSteer(sessionId, message)
  allowPreToolUse(message)
}

function shouldInspectShellInput(input: { tool_name?: string }): boolean {
  return isClaudeCode && isShellTool(input?.tool_name ?? "")
}

async function checkRules(
  command: string,
  rules: SwizTasksRule[],
  sessionId: string,
  tipContext: SessionTaskTipContext
): Promise<void> {
  for (const rule of rules) {
    if (!rule.match(command)) continue

    if (rule.severity === "warn") {
      await emitWarnAndAllow(rule, sessionId, tipContext)
    } else {
      // For deny rules: if auto-steer can handle it, allow + steer instead
      if (sessionId && (await scheduleAutoSteer(sessionId, rule.message))) {
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
