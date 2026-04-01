#!/usr/bin/env bun
// PreToolUse hook: Block TaskUpdate calls that contain unsupported fields.
// The TaskUpdate tool accepts a fixed schema; unknown fields (e.g. `notes`)
// cause an InputValidationError at the API boundary before any work is done.
//
// Dual-mode: exports a SwizHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { preToolUseDeny, runSwizHookAsMain, type SwizHook } from "../src/SwizHook.ts"
import { TASK_UPDATE_ALLOWED_FIELDS as ALLOWED_FIELDS } from "./schemas.ts"

const pretoolusTaskupdateSchema: SwizHook = {
  name: "pretooluse-taskupdate-schema",
  event: "preToolUse",
  matcher: "TaskUpdate|update_plan",
  timeout: 5,

  run(rawInput) {
    const input = rawInput as Record<string, any>
    const toolInput: Record<string, any> = (input.tool_input as Record<string, any>) ?? {}

    const unsupported = Object.keys(toolInput).filter((k) => !ALLOWED_FIELDS.has(k))
    if (unsupported.length > 0) {
      const allowed = [...ALLOWED_FIELDS].join(", ")
      const reason =
        `TaskUpdate received unsupported field(s): ${unsupported.map((f) => `\`${f}\``).join(", ")}.\n\n` +
        `Allowed fields: ${allowed}.`
      return preToolUseDeny(reason)
    }

    return {}
  },
}

export default pretoolusTaskupdateSchema

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolusTaskupdateSchema)
