#!/usr/bin/env bun
/**
 * PreToolUse hook: Block gh issue edit commands that demote issues from "ready" to "backlog".
 * Prevents agents from gaming readiness hooks by downgrading ready work they want to avoid.
 *
 * Dual-mode: exports a SwizShellHook for inline dispatch and remains
 * executable as a standalone script for backwards compatibility and testing.
 */

import { runSwizHookAsMain, type SwizShellHook } from "../src/SwizHook.ts"
import type { ShellHookInput } from "../src/schemas.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { preToolUseAllow, preToolUseDeny } from "../src/utils/hook-utils.ts"

const GH_ISSUE_EDIT_RE = /gh\s+issue\s+edit\b/
const AUDITED_CORRECTION_RE = /\bcorrection\s*:/i

function evaluate(input: ShellHookInput) {
  if (!isShellTool(input.tool_name ?? "")) return {}

  const command: string = input.tool_input?.command ?? ""
  if (!GH_ISSUE_EDIT_RE.test(command)) return {}

  const removesReady = /--remove-label\s+["']?ready["']?/.test(command)
  const addsBacklog = /--add-label\s+["']?backlog["']?/.test(command)

  if (!removesReady || !addsBacklog) return preToolUseAllow("")

  // Audited correction: append `# correction: <reason>` to document why the
  // demotion is valid (e.g. mislabeled during triage). The shell comment is
  // ignored by gh but serves as an explicit human-readable audit trail.
  if (AUDITED_CORRECTION_RE.test(command)) {
    return preToolUseAllow("Audited correction accepted — the '# correction:' reason was recorded.")
  }

  return preToolUseDeny(
    "Do not demote issues from 'ready' to 'backlog' without an explicit reason. " +
      "Ready issues have been triaged and accepted for work.\n\n" +
      "If this is a legitimate correction (e.g. the issue was mislabeled during triage), " +
      "append a correction reason to your command as a shell comment:\n\n" +
      "  gh issue edit <number> --remove-label ready --add-label backlog # correction: <reason>\n\n" +
      "The shell comment is ignored by gh but documents why the demotion is valid. " +
      "If the issue is genuinely out of scope, leave its labels unchanged and work on a different issue instead."
  )
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
