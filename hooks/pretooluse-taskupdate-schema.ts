#!/usr/bin/env bun
// PreToolUse hook: Block TaskUpdate calls that contain unsupported fields.
// The TaskUpdate tool accepts a fixed schema; unknown fields (e.g. `notes`)
// cause an InputValidationError at the API boundary before any work is done.

import { denyPreToolUse, preToolActionRequired } from "./hook-utils.ts"

const ALLOWED_FIELDS = new Set([
  "taskId",
  "status",
  "subject",
  "description",
  "activeForm",
  "owner",
  "metadata",
  "addBlocks",
  "addBlockedBy",
])

const input = await Bun.stdin.json()
const toolInput: Record<string, unknown> = input?.tool_input ?? {}

const unsupported = Object.keys(toolInput).filter((k) => !ALLOWED_FIELDS.has(k))

if (unsupported.length > 0) {
  const allowed = [...ALLOWED_FIELDS].join(", ")
  const reason =
    `TaskUpdate received unsupported field(s): ${unsupported.map((f) => `\`${f}\``).join(", ")}.\n\n` +
    `Allowed fields: ${allowed}.\n\n` +
    `To complete a task with evidence, use:\n` +
    `  swiz tasks complete <id> --evidence "note:..."`
  denyPreToolUse(reason + preToolActionRequired(reason, { includeReassessmentAdvice: false }))
}
