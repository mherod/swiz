#!/usr/bin/env bun

/**
 * PreToolUse hook: Block Bash/Shell commands that are actually tool invocations.
 * Example failure mode:
 *   Bash(TaskCreate ...; swiz tasks ...)
 * where `TaskCreate` is a tool name, not an executable shell command.
 *
 * Dual-mode: exports a SwizShellHook for inline dispatch and remains
 * executable as a standalone script for backwards compatibility and testing.
 */

import { normalizeCommand, stripHeredocs } from "../src/command-utils.ts"
import { runSwizHookAsMain, type SwizShellHook } from "../src/SwizHook.ts"
import type { ShellHookInput } from "../src/schemas.ts"
import {
  EDIT_TOOLS,
  isShellTool,
  NOTEBOOK_TOOLS,
  READ_TOOLS,
  SEARCH_TOOLS,
  SHELL_TOOLS,
  TASK_TOOLS,
  WRITE_TOOLS,
} from "../src/tool-matchers.ts"
import { preToolUseAllow, preToolUseDeny } from "../src/utils/hook-utils.ts"
import { escapeRegex, SHELL_STATEMENT_BOUNDARY } from "../src/utils/shell-patterns.ts"

// `update_plan` is Codex's planning UI — not in TASK_TOOLS (#570) but still
// a reserved tool name that must not appear as a shell command.
const EXTRA_TOOL_NAMES = [
  "AskUserQuestion",
  "LS",
  "MultiEdit",
  "WebFetch",
  "WebSearch",
  "update_plan",
]

const TOOL_NAMES = [
  ...new Set([
    ...SHELL_TOOLS,
    ...EDIT_TOOLS,
    ...WRITE_TOOLS,
    ...READ_TOOLS,
    ...SEARCH_TOOLS,
    ...NOTEBOOK_TOOLS,
    ...TASK_TOOLS,
    ...EXTRA_TOOL_NAMES,
  ]),
].sort((a, b) => b.length - a.length)

const LEADING_ENV_ASSIGNMENTS = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s;|&()]+)\s+)*`
const TOOL_NAME_ALT = TOOL_NAMES.map(escapeRegex).join("|")
const MIXED_TOOL_CALL_RE = new RegExp(
  `${SHELL_STATEMENT_BOUNDARY}\\s*${LEADING_ENV_ASSIGNMENTS}(?<tool>${TOOL_NAME_ALT})(?=$|\\s|[();|&])`
)

function toolSpecificGuidance(toolName: string): string {
  if (TASK_TOOLS.has(toolName)) {
    return [
      `Call \`${toolName}\` directly instead of wrapping it in Bash.`,
      "If you meant the swiz task CLI rather than the tool, run `swiz tasks ...`.",
    ].join("\n")
  }

  if (SHELL_TOOLS.has(toolName)) {
    return [
      `Do not nest \`${toolName}\` inside another shell tool call.`,
      "Pass only the raw terminal command to Bash/Shell, for example: `git status`.",
    ].join("\n")
  }

  return `Call \`${toolName}\` directly via the tool interface instead of invoking it as a shell command.`
}

function evaluate(input: ShellHookInput) {
  // In standalone mode the matcher isn't applied, so guard on tool name.
  if (!isShellTool(input.tool_name ?? "")) return {}

  const rawCommand = String(input.tool_input?.command ?? "")
  const normalizedCommand = stripHeredocs(normalizeCommand(rawCommand))
  const match = MIXED_TOOL_CALL_RE.exec(normalizedCommand)

  if (!match?.groups?.tool) {
    return preToolUseAllow("Continue in direct-tool-invocation mode.")
  }

  const toolName = match.groups.tool
  const commandPreview = rawCommand.replace(/\s+/g, " ").trim().slice(0, 140) || toolName

  return preToolUseDeny(
    `Mixed-up tool call detected: \`${toolName}\` is a tool, not a terminal command.\n\n` +
      "Do not invoke tools inside Bash/Shell.\n\n" +
      `Command:\n  ${commandPreview}\n\n` +
      toolSpecificGuidance(toolName)
  )
}

const pretoolusNoMixedToolCalls: SwizShellHook = {
  name: "pretooluse-no-mixed-tool-calls",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 5,

  run(input) {
    return evaluate(input as ShellHookInput)
  },
}

export default pretoolusNoMixedToolCalls

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolusNoMixedToolCalls)
