#!/usr/bin/env bun
// PreToolUse hook: Deny TaskCreate when subject looks like a compound task.
// Patterns detected:
//   " and "        — joining two concerns ("Fix A and B")
//   2+ commas      — listing 3+ items ("Fix A, B, and C")
//   multiple #NNN  — referencing multiple issues ("Fix #12 and #34")

import { denyPreToolUse } from "./hook-utils.ts"
import { detect, formatMessage } from "./task-subject-validation.ts"

const input = await Bun.stdin.json()
const subject: string = input?.tool_input?.subject ?? ""

const result = detect(subject)
if (result.matched) {
  denyPreToolUse(formatMessage(result))
}
