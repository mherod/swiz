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
  isFileEditTool,
  isSettingDisableCommand,
  isShellTool,
} from "../src/utils/hook-utils.ts"

// All recognised aliases for the sandboxedEdits setting
const SANDBOX_ALIASES = ["sandboxed-edits", "sandboxededits", "sandboxed_edits", "sandboxedEdits"]

// All recognised aliases for the trunkMode setting
const TRUNK_MODE_ALIASES = ["trunk-mode", "trunkmode", "trunk_mode", "trunkMode"]

// Matches any JSON file directly inside a .swiz/ directory.
// Direct edits to these files bypass setting validation and schema enforcement,
// and can be used to disable sandbox protections — so we block them unconditionally,
// exactly as we block `swiz settings disable sandboxed-edits` shell commands.
const SWIZ_CONFIG_RE = /(?:^|[/\\])\.swiz[/\\][^/\\]+\.json$/

/**
 * Returns true when the command attempts to disable the sandboxed-edits setting.
 * Matches both disable paths:
 *   swiz settings disable <alias>
 *   swiz settings set <alias> false
 */
export function isSandboxDisableCommand(command: string): boolean {
  return isSettingDisableCommand(command, SANDBOX_ALIASES)
}

/**
 * Returns true when the command attempts to disable the trunk-mode setting.
 */
export function isTrunkModeDisableCommand(command: string): boolean {
  return isSettingDisableCommand(command, TRUNK_MODE_ALIASES)
}

if (import.meta.main) {
  const input = await Bun.stdin.json()
  const toolName: string = input?.tool_name ?? ""

  if (isShellTool(toolName)) {
    const command: string = input?.tool_input?.command ?? ""
    if (isSandboxDisableCommand(command)) {
      denyPreToolUse(
        "Disabling sandboxed-edits is not permitted from agent Bash commands.\n\n" +
          "The sandbox can only be disabled by the user directly at the terminal.\n" +
          buildIssueGuidance(null)
      )
    }
    if (isTrunkModeDisableCommand(command)) {
      denyPreToolUse(
        "Disabling trunk-mode is not permitted from agent Bash commands.\n\n" +
          "Trunk mode can only be disabled by the user directly at the terminal.\n" +
          buildIssueGuidance(null)
      )
    }
  }

  if (isFileEditTool(toolName)) {
    const filePath: string = input?.tool_input?.file_path ?? ""
    if (SWIZ_CONFIG_RE.test(filePath)) {
      denyPreToolUse(
        "Editing swiz config files directly is not permitted from agent file edits.\n\n" +
          "Use the swiz CLI instead:\n" +
          "  swiz settings set <key> <value>\n" +
          "  swiz settings enable <setting>\n" +
          "  swiz settings disable <setting>\n" +
          "  swiz state set <state>\n" +
          buildIssueGuidance(null)
      )
    }
  }
}
