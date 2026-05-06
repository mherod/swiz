#!/usr/bin/env bun
// PreToolUse hook: Block agent Bash commands that disable strict-no-direct-main.
//
// strict-no-direct-main prevents agents from pushing non-trivial changes
// directly to the default branch without a feature branch + PR workflow.
// An agent can trivially bypass it by running:
//   swiz settings disable strict-no-direct-main
// This hook denies that command unconditionally — the setting can only be
// disabled by the user directly at the terminal (where this hook never fires).
//
// Dual-mode: exports a SwizHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { runSwizHookAsMain, type SwizHook } from "../src/SwizHook.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { preToolUseAllow, preToolUseDeny } from "../src/utils/hook-utils.ts"
import { buildIssueGuidance, isSettingDisableCommand } from "../src/utils/inline-hook-helpers.ts"

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

const pretoolusePprotectStrictMain: SwizHook = {
  name: "pretooluse-protect-strict-main",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 5,

  run(rawInput) {
    const input = rawInput as Record<string, any>
    if (!isShellTool(String(input.tool_name ?? ""))) return {}

    const command: string = ((input.tool_input as Record<string, any>)?.command as string) ?? ""

    if (isStrictMainDisableCommand(command)) {
      return preToolUseDeny(
        "Disabling strict-no-direct-main is not permitted from agent Bash commands.\n\n" +
          "This setting enforces the feature-branch workflow for non-trivial changes.\n" +
          "It can only be disabled by the user directly at the terminal.\n" +
          buildIssueGuidance(null)
      )
    }

    return preToolUseAllow("Continue with strict-no-direct-main protection enabled.")
  },
}

export default pretoolusePprotectStrictMain

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) {
  await runSwizHookAsMain(pretoolusePprotectStrictMain)
}
