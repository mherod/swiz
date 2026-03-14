#!/usr/bin/env bun
// PreToolUse hook: Block agent Bash commands that disable sandboxed-edits.
//
// The sandbox prevents agents from editing files outside the session project.
// An agent can trivially bypass it by running `swiz settings disable sandboxed-edits`.
// This hook denies that command unconditionally — the sandbox can only be
// disabled by the user directly at the terminal (where this hook never fires).

import {
  buildIssueGuidance,
  denyPreToolUse,
  isSettingDisableCommand,
  isShellTool,
} from "./hook-utils.ts"

// All recognised aliases for the sandboxedEdits setting
const SANDBOX_ALIASES = ["sandboxed-edits", "sandboxededits", "sandboxed_edits", "sandboxedEdits"]

/**
 * Returns true when the command attempts to disable the sandboxed-edits setting.
 * Matches both disable paths:
 *   swiz settings disable <alias>
 *   swiz settings set <alias> false
 */
export function isSandboxDisableCommand(command: string): boolean {
  return isSettingDisableCommand(command, SANDBOX_ALIASES)
}

if (import.meta.main) {
  const input = await Bun.stdin.json()
  if (!isShellTool(input?.tool_name ?? "")) process.exit(0)

  const command: string = input?.tool_input?.command ?? ""

  if (isSandboxDisableCommand(command)) {
    denyPreToolUse(
      "Disabling sandboxed-edits is not permitted from agent Bash commands.\n\n" +
        "The sandbox can only be disabled by the user directly at the terminal.\n" +
        buildIssueGuidance(null)
    )
  }
}
