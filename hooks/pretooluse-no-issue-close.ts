#!/usr/bin/env bun
// PreToolUse hook: Block closing issues via Bash commands.
// Issues must only be closed by pushing commits with "Fixes #N" in the message.

import { allowPreToolUse, denyPreToolUse, isShellTool } from "./utils/hook-utils.ts"
import { shellSegmentCommandRe } from "./utils/shell-patterns.ts"

/**
 * Strip quoted string contents so patterns inside evidence args, commit
 * messages, or other flag values don't trigger false positives.
 */
function stripQuotedStrings(cmd: string): string {
  return cmd.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'[^']*'/g, "''")
}

const input = await Bun.stdin.json().catch(() => null)
if (!input) process.exit(0)
if (!isShellTool(input.tool_name ?? "")) process.exit(0)

const command: string = input.tool_input?.command ?? ""
const stripped = stripQuotedStrings(command)

// Match at command boundaries so patterns inside quoted strings don't match
const GH_ISSUE_CLOSE_RE = shellSegmentCommandRe("gh\\s+issue\\s+close\\b")
const SWIZ_ISSUE_CLOSE_RE = shellSegmentCommandRe("swiz\\s+issue\\s+close\\b")
const SWIZ_ISSUE_RESOLVE_RE = shellSegmentCommandRe("swiz\\s+issue\\s+resolve\\b")
// Match gh api PATCH to set state=closed on issues
const GH_API_ISSUE_CLOSE_RE = /gh\s+api\b.*issues\/\d+.*state[=\s]+closed/
const GH_API_STATE_CLOSED_RE = /gh\s+api\b.*-f\s+state=closed/

if (
  GH_ISSUE_CLOSE_RE.test(stripped) ||
  SWIZ_ISSUE_CLOSE_RE.test(stripped) ||
  SWIZ_ISSUE_RESOLVE_RE.test(stripped) ||
  GH_API_ISSUE_CLOSE_RE.test(stripped) ||
  GH_API_STATE_CLOSED_RE.test(stripped)
) {
  denyPreToolUse(
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

allowPreToolUse("No issue-closing command detected")
