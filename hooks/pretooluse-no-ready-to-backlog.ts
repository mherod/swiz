#!/usr/bin/env bun
/**
 * PreToolUse hook: Block gh issue edit commands that demote issues from "ready" to "backlog".
 * Prevents agents from gaming readiness hooks by downgrading ready work they want to avoid.
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

const GH_ISSUE_EDIT_RE = /gh\s+issue\s+edit\b/

function evaluate(input: ShellHookInput) {
  if (!isShellTool(input.tool_name ?? "")) return {}

  const command: string = input.tool_input?.command ?? ""
  if (!GH_ISSUE_EDIT_RE.test(command)) return {}

  const removesReady = /--remove-label\s+["']?ready["']?/.test(command)
  const addsBacklog = /--add-label\s+["']?backlog["']?/.test(command)

  if (removesReady && addsBacklog) {
    return preToolUseDeny(
      "Do not demote issues from 'ready' to 'backlog'. Ready issues have been triaged and accepted for work.\n\n" +
        "If the issue is genuinely out of scope for your current task, leave its labels unchanged and work on a different issue instead.\n\n" +
        "Use `/next-issue` to find the next actionable issue."
    )
  }

  return preToolUseAllow("")
}

const pretoolusNoReadyToBacklog: SwizShellHook = {
  name: "pretooluse-no-ready-to-backlog",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 5,

  run(input) {
    return evaluate(input as ShellHookInput)
  },
}

export default pretoolusNoReadyToBacklog

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolusNoReadyToBacklog)
