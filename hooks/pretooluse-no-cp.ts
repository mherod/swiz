#!/usr/bin/env bun
/**
 * PreToolUse hook: Block `cp` and recommend `ditto` for copy operations.
 *
 * Dual-mode: exports a SwizShellHook for inline dispatch and remains
 * executable as a standalone script for backwards compatibility and testing.
 */

import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizShellHook,
} from "../src/SwizHook.ts"
import type { ShellHookInput } from "../src/schemas.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { shellSegmentCommandRe } from "../src/utils/shell-patterns.ts"

const DENY_REASON = [
  "Do not use `cp` for file copying in this workflow.",
  "",
  "Use `ditto` instead (preserves metadata and handles directories cleanly):",
  "  ditto <source> <destination>",
  "  ditto -V <source> <destination>   # verbose copy",
].join("\n")

function evaluate(input: ShellHookInput) {
  // In standalone mode the matcher isn't applied, so guard on tool name.
  if (!isShellTool(input.tool_name ?? "")) return {}

  const command: string = input.tool_input?.command ?? ""

  if (!shellSegmentCommandRe("cp(?:\\s|$)").test(command))
    return preToolUseAllow("No cp invocation detected")

  return preToolUseDeny(DENY_REASON)
}

const pretoolusNoCp: SwizShellHook = {
  name: "pretooluse-no-cp",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 5,

  run(input) {
    return evaluate(input as ShellHookInput)
  },
}

export default pretoolusNoCp

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolusNoCp)
