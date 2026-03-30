#!/usr/bin/env bun
// PreToolUse hook: Deny TaskCreate when subject looks like a compound task.
// Patterns detected:
//   " and "        — joining two concerns ("Fix A and B")
//   2+ commas      — listing 3+ items ("Fix A, B, and C")
//   multiple #NNN  — referencing multiple issues ("Fix #12 and #34")
//
// Dual-mode: exports a SwizHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { preToolUseDeny, runSwizHookAsMain, type SwizHook } from "../src/SwizHook.ts"
import { detect, formatMessage } from "../src/tasks/task-subject-validation.ts"

const pretoolUseTaskSubjectValidation: SwizHook = {
  name: "pretooluse-task-subject-validation",
  event: "preToolUse",
  matcher: "TaskCreate|TodoWrite",
  timeout: 5,

  run(rawInput) {
    const input = rawInput as Record<string, unknown>
    const toolInput = input.tool_input as Record<string, unknown> | undefined
    const subject: string = (toolInput?.subject as string) ?? ""

    const result = detect(subject)
    if (result.matched) {
      return preToolUseDeny(formatMessage(result))
    }

    return {}
  },
}

export default pretoolUseTaskSubjectValidation

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolUseTaskSubjectValidation)
