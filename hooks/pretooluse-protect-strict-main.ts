#!/usr/bin/env bun
// PreToolUse hook: Block agent Bash commands that disable strict-no-direct-main.
//
// strict-no-direct-main prevents agents from pushing non-trivial changes
// directly to the default branch without a feature branch + PR workflow.
// An agent can trivially bypass it by running:
//   swiz settings disable strict-no-direct-main
// This hook denies that command unconditionally — the setting can only be
// disabled by the user directly at the terminal (where this hook never fires).

import {
  allowPreToolUse,
  buildIssueGuidance,
  denyPreToolUse,
  isSettingDisableCommand,
  isShellTool,
} from "./hook-utils.ts"

// All recognised aliases for the strictNoDirectMain setting
const STRICT_MAIN_ALIASES = [
  "strict-no-direct-main",
  "strictnodirectmain",
  "strict_no_direct_main",
  "strict-main",
  "no-direct-main",
  "strictNoDirectMain",
]

/**
 * Returns true when the command attempts to disable the strict-no-direct-main setting.
 * Matches both disable paths:
 *   swiz settings disable <alias>
 *   swiz settings set <alias> false
 */
export function isStrictMainDisableCommand(command: string): boolean {
  return isSettingDisableCommand(command, STRICT_MAIN_ALIASES)
}

if (import.meta.main) {
  const input = await Bun.stdin.json()
  if (!isShellTool(input?.tool_name ?? "")) process.exit(0)

  const command: string = input?.tool_input?.command ?? ""

  if (isStrictMainDisableCommand(command)) {
    denyPreToolUse(
      "Disabling strict-no-direct-main is not permitted from agent Bash commands.\n\n" +
        "This setting enforces the feature-branch workflow for non-trivial changes.\n" +
        "It can only be disabled by the user directly at the terminal.\n" +
        buildIssueGuidance(null)
    )
  }
  allowPreToolUse("Command does not disable strict-no-direct-main")
}
