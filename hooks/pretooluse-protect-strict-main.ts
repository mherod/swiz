#!/usr/bin/env bun
// PreToolUse hook: Block agent Bash commands that disable strict-no-direct-main.
//
// strict-no-direct-main prevents agents from pushing non-trivial changes
// directly to the default branch without a feature branch + PR workflow.
// An agent can trivially bypass it by running:
//   swiz settings disable strict-no-direct-main
// This hook denies that command unconditionally — the setting can only be
// disabled by the user directly at the terminal (where this hook never fires).

import { buildIssueGuidance, denyPreToolUse, isShellTool } from "./hook-utils.ts"

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
  for (const alias of STRICT_MAIN_ALIASES) {
    // swiz settings disable <alias>
    if (new RegExp(`swiz\\s+settings\\s+disable\\s+${alias}(?:\\s|$)`).test(command)) return true
    // swiz settings set <alias> false
    if (new RegExp(`swiz\\s+settings\\s+set\\s+${alias}\\s+false(?:\\s|$)`).test(command))
      return true
  }
  return false
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
}
