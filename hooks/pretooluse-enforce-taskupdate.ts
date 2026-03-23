#!/usr/bin/env bun
// PreToolUse hook: Enforce TaskUpdate tool instead of `swiz tasks` CLI in Claude Code.
// In Claude Code environment, prefer native task tools (TaskCreate, TaskUpdate, TaskGet, TaskList)
// over the swiz CLI equivalent. This improves task tracking and eliminates subprocess overhead.

import {
  allowPreToolUse,
  denyPreToolUse,
  isRunningInAgent,
  isShellTool,
} from "./utils/hook-utils.ts"

// Only enforce in agent/Claude Code context
const isClaudeCode = isRunningInAgent() || process.env.CLAUDECODE === "1"

interface SwizTasksRule {
  /** Regex to match this swiz tasks subcommand */
  match: (command: string) => boolean
  /** "deny" blocks the command. "warn" allows with a hint. Default: "deny". */
  severity?: "deny" | "warn"
  /** Human-readable guidance */
  message: string
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
      message:
        "Tip: Use the TaskList or TaskGet tool instead of `swiz tasks list/get`.\n\n" +
        "In Claude Code, prefer native task tools for better integration:\n" +
        "  • TaskList  — list all tasks\n" +
        "  • TaskGet   — fetch a specific task by ID\n\n" +
        "Native tools are tracked, audited, and eliminate subprocess overhead.",
    },
  ]
}

function checkRules(command: string, rules: SwizTasksRule[]): void {
  for (const rule of rules) {
    if (!rule.match(command)) continue

    if (rule.severity === "warn") {
      allowPreToolUse(rule.message)
    } else {
      denyPreToolUse(rule.message)
    }
  }

  // No rules matched — allow the command
  allowPreToolUse("")
}

async function main() {
  const input = await Bun.stdin.json()

  // Only apply in Claude Code environment
  if (!isClaudeCode) {
    process.exit(0)
  }

  // Only check shell tools (Bash, Shell)
  if (!isShellTool(input?.tool_name ?? "")) {
    process.exit(0)
  }

  const command: string = input?.tool_input?.command ?? ""
  const rules = buildSwizTasksRules()
  checkRules(command, rules)
}

if (import.meta.main) {
  void main()
}
