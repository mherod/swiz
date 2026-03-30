#!/usr/bin/env bun
// PreToolUse hook: Block agent Bash commands that disable sandboxed-edits.
//
// The sandbox prevents agents from editing files outside the session project.
// An agent can trivially bypass it by running `swiz settings disable sandboxed-edits`.
// This hook denies that command unconditionally — the sandbox can only be
// disabled by the user directly at the terminal (where this hook never fires).
//
// Dual-mode: exports a SwizToolHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizToolHook,
} from "../src/SwizHook.ts"
import { isFileEditTool, isShellTool } from "../src/tool-matchers.ts"
import { buildIssueGuidance, isSettingDisableCommand } from "../src/utils/inline-hook-helpers.ts"

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

const pretoolUseProtectSandbox: SwizToolHook = {
  name: "pretooluse-protect-sandbox",
  event: "preToolUse",
  matcher: "Bash|Edit|Write|NotebookEdit",
  timeout: 5,

  run(rawInput) {
    const input = rawInput as Record<string, unknown>
    const toolName: string = (input.tool_name as string) ?? ""
    const toolInput = input.tool_input as Record<string, string> | undefined

    if (isShellTool(toolName)) {
      const command: string = toolInput?.command ?? ""
      if (isSandboxDisableCommand(command)) {
        return preToolUseDeny(
          "Disabling sandboxed-edits is not permitted from agent Bash commands.\n\n" +
            "The sandbox can only be disabled by the user directly at the terminal.\n" +
            buildIssueGuidance(null)
        )
      }
      if (isTrunkModeDisableCommand(command)) {
        return preToolUseDeny(
          "Disabling trunk-mode is not permitted from agent Bash commands.\n\n" +
            "Trunk mode can only be disabled by the user directly at the terminal.\n" +
            buildIssueGuidance(null)
        )
      }
    }

    if (isFileEditTool(toolName)) {
      const filePath: string = toolInput?.file_path ?? ""
      if (SWIZ_CONFIG_RE.test(filePath)) {
        return preToolUseDeny(
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

    return preToolUseAllow("")
  },
}

export default pretoolUseProtectSandbox

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolUseProtectSandbox)
