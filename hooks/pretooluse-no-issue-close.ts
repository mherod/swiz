#!/usr/bin/env bun
/**
 * PreToolUse hook: Block closing issues via Bash commands.
 * Issues must only be closed by pushing commits with "Fixes #N" in the message.
 *
 * Dual-mode: exports a SwizShellHook for inline dispatch and remains
 * executable as a standalone script for backwards compatibility and testing.
 */

import { runSwizHookAsMain, type SwizShellHook } from "../src/SwizHook.ts"
import type { ShellHookInput } from "../src/schemas.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { preToolUseAllow, preToolUseDeny } from "../src/utils/hook-utils.ts"
import { shellSegmentCommandRe, stripQuotedShellStrings } from "../src/utils/shell-patterns.ts"

const GH_ISSUE_CLOSE_RE = shellSegmentCommandRe("gh\\s+issue\\s+close\\b")
const SWIZ_ISSUE_CLOSE_RE = shellSegmentCommandRe("swiz\\s+issue\\s+close\\b")
const SWIZ_ISSUE_RESOLVE_RE = shellSegmentCommandRe("swiz\\s+issue\\s+resolve\\b")
const GH_API_ISSUE_CLOSE_RE = /gh\s+api\b.*issues\/\d+.*state[=\s]+closed/
const GH_API_STATE_CLOSED_RE = /gh\s+api\b.*-f\s+state=closed/

function evaluate(input: ShellHookInput) {
  if (!isShellTool(input.tool_name ?? "")) return {}

  const command: string = input.tool_input?.command ?? ""
  const stripped = stripQuotedShellStrings(command, { preserveQuotePairs: true })

  if (
    GH_ISSUE_CLOSE_RE.test(stripped) ||
    SWIZ_ISSUE_CLOSE_RE.test(stripped) ||
    SWIZ_ISSUE_RESOLVE_RE.test(stripped) ||
    GH_API_ISSUE_CLOSE_RE.test(stripped) ||
    GH_API_STATE_CLOSED_RE.test(stripped)
  ) {
    return preToolUseDeny(
      [
        "Do not close issues via CLI commands.",
        "",
        "Issues must only be closed by pushing a commit whose message references the issue:",
        '  git commit -m "fix(scope): description\\n\\nFixes #123"',
        "",
        "GitHub automatically closes the issue when the commit lands on the default branch.",
        "This ensures every issue closure is backed by a code change.",
      ].join("\n")
    )
  }

  return preToolUseAllow("Continue in commit-backed issue-closure mode.")
}

const pretoolusNoIssueClose: SwizShellHook = {
  name: "pretooluse-no-issue-close",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 5,

  run(input) {
    return evaluate(input as ShellHookInput)
  },
}

export default pretoolusNoIssueClose

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolusNoIssueClose)
