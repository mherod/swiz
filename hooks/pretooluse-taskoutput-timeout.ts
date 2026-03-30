#!/usr/bin/env bun
/**
 * PreToolUse hook: Block TaskOutput calls with missing or excessive timeout.
 * Missing timeouts block the session indefinitely; timeouts > 120s waste time.
 *
 * Dual-mode: exports a SwizToolHook for inline dispatch and remains
 * executable as a standalone script for backwards compatibility and testing.
 */

import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizToolHook,
} from "../src/SwizHook.ts"
import type { ToolHookInput } from "./schemas.ts"

const MAX_TIMEOUT_MS = 120_000

function evaluate(input: ToolHookInput) {
  const toolInput = input.tool_input ?? {}
  const timeout = toolInput.timeout

  if (timeout === undefined || timeout === null) {
    return preToolUseDeny(
      [
        "TaskOutput requires a `timeout` parameter (number, milliseconds).",
        "",
        "Missing timeouts block the session indefinitely waiting for output.",
        `Set timeout to at most ${MAX_TIMEOUT_MS}ms (${MAX_TIMEOUT_MS / 1000}s).`,
      ].join("\n")
    )
  }

  if (typeof timeout !== "number") {
    return preToolUseDeny(
      [
        `TaskOutput \`timeout\` must be a number, got ${typeof timeout}.`,
        "",
        `Set timeout to at most ${MAX_TIMEOUT_MS}ms (${MAX_TIMEOUT_MS / 1000}s).`,
      ].join("\n")
    )
  }

  if (timeout > MAX_TIMEOUT_MS) {
    return preToolUseDeny(
      [
        `TaskOutput timeout ${timeout}ms exceeds the ${MAX_TIMEOUT_MS / 1000}s maximum.`,
        "",
        `Reduce timeout to at most ${MAX_TIMEOUT_MS}ms. Long waits block the session and waste time.`,
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
