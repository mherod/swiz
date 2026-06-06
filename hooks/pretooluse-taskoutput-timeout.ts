#!/usr/bin/env bun
/**
 * PreToolUse hook: Block TaskOutput calls with missing or excessive timeout.
 * Missing timeouts block the session indefinitely; timeouts > 120s waste time.
 *
 * Dual-mode: exports a SwizToolHook for inline dispatch and remains
 * executable as a standalone script for backwards compatibility and testing.
 */

import { formatDurationPrecise } from "../src/format-duration.ts"
import { runSwizHookAsMain, type SwizToolHook } from "../src/SwizHook.ts"
import type { ToolHookInput } from "../src/schemas.ts"
import { preToolUseAllow, preToolUseDeny } from "../src/utils/hook-utils.ts"

const MAX_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_LABEL = formatDurationPrecise(MAX_TIMEOUT_MS)
const RETRY_INSTRUCTION = `To proceed, retry the TaskOutput call with \`timeout: ${MAX_TIMEOUT_MS}\` (${MAX_TIMEOUT_LABEL}) or a smaller value.`

function evaluate(input: ToolHookInput) {
  const toolInput = input.tool_input ?? {}
  const timeout = toolInput.timeout

  if (timeout === undefined || timeout === null) {
    return preToolUseDeny(
      [
        "TaskOutput requires a `timeout` parameter (number, milliseconds).",
        "",
        "Missing timeouts block the session indefinitely waiting for output.",
        RETRY_INSTRUCTION,
      ].join("\n")
    )
  }

  if (typeof timeout !== "number") {
    return preToolUseDeny(
      [
        `TaskOutput \`timeout\` must be a number, got ${typeof timeout}.`,
        "",
        RETRY_INSTRUCTION,
      ].join("\n")
    )
  }

  if (timeout > MAX_TIMEOUT_MS) {
    return preToolUseDeny(
      [
        `TaskOutput timeout of ${formatDurationPrecise(timeout)} exceeds the ${MAX_TIMEOUT_LABEL} maximum.`,
        "",
        "Long waits block the session and waste time.",
        RETRY_INSTRUCTION,
      ].join("\n")
    )
  }

  return preToolUseAllow("")
}

const pretoolusTaskoutputTimeout: SwizToolHook = {
  name: "pretooluse-taskoutput-timeout",
  event: "preToolUse",
  matcher: "TaskOutput",
  timeout: 5,

  run(input) {
    return evaluate(input)
  },
}

export default pretoolusTaskoutputTimeout

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolusTaskoutputTimeout)
