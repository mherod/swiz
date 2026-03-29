#!/usr/bin/env bun
// PreToolUse hook: Block gh issue edit commands that demote issues from "ready" to "backlog".
// Prevents agents from gaming readiness hooks by downgrading ready work they want to avoid.

import { denyPreToolUse, isShellTool } from "../src/utils/hook-utils.ts"

const GH_ISSUE_EDIT_RE = /gh\s+issue\s+edit\b/

async function main() {
  const input = await Bun.stdin.json()
  if (!isShellTool(input?.tool_name ?? "")) process.exit(0)

  const command: string = input?.tool_input?.command ?? ""
  if (!GH_ISSUE_EDIT_RE.test(command)) process.exit(0)

  const removesReady = /--remove-label\s+["']?ready["']?/.test(command)
  const addsBacklog = /--add-label\s+["']?backlog["']?/.test(command)

  if (removesReady && addsBacklog) {
    denyPreToolUse(
      "Do not demote issues from 'ready' to 'backlog'. Ready issues have been triaged and accepted for work.\n\n" +
        "If the issue is genuinely out of scope for your current task, leave its labels unchanged and work on a different issue instead.\n\n" +
        "Use `/next-issue` to find the next actionable issue."
    )
  }
}

if (import.meta.main) {
  void main()
}
