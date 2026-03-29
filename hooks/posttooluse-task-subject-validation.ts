#!/usr/bin/env bun

// PostToolUse hook: Block TaskCreate when subject looks like a compound task.
// Patterns detected:
//   " and "        — joining two concerns ("Fix A and B")
//   2+ commas      — listing 3+ items ("Fix A, B, and C")
//   multiple #NNN  — referencing multiple issues ("Fix #12 and #34")

import { denyPostToolUse } from "../src/utils/hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"
import { detect, formatMessage } from "./task-subject-validation.ts"

async function main(): Promise<void> {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())
  const subject = String(input.tool_input?.subject ?? "")

  const result = detect(subject)
  if (!result.matched) return

  const message = formatMessage(
    result,
    "Delete this task and create individual tasks for each part."
  )
  denyPostToolUse(message)
}

if (import.meta.main) void main()
