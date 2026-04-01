#!/usr/bin/env bun

// PostToolUse hook: Block TaskCreate when subject looks like a compound task.
// Patterns detected:
//   " and "        — joining two concerns ("Fix A and B")
//   2+ commas      — listing 3+ items ("Fix A, B, and C")
//   multiple #NNN  — referencing multiple issues ("Fix #12 and #34")

import type { SwizHookOutput, SwizToolHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { detect, formatMessage } from "../src/tasks/task-subject-validation.ts"
import { buildDenyPostToolUseOutput } from "../src/utils/hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

export function evaluatePosttooluseTaskSubjectValidation(input: unknown): SwizHookOutput {
  const parsed = toolHookInputSchema.parse(input)
  const subject = String(parsed.tool_input?.subject ?? "")

  const result = detect(subject)
  if (!result.matched) return {}

  const message = formatMessage(
    result,
    "Delete this task and create individual tasks for each part."
  )
  return buildDenyPostToolUseOutput(message)
}

const posttooluseTaskSubjectValidation: SwizToolHook = {
  name: "posttooluse-task-subject-validation",
  event: "postToolUse",
  matcher: "TaskCreate|TodoWrite",
  timeout: 5,

  run(input) {
    return evaluatePosttooluseTaskSubjectValidation(input)
  },
}

export default posttooluseTaskSubjectValidation

if (import.meta.main) {
  await runSwizHookAsMain(posttooluseTaskSubjectValidation)
}
