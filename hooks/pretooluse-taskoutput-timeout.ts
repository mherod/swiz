#!/usr/bin/env bun

// PreToolUse hook: Block TaskOutput calls with missing or excessive timeout.
// Missing timeouts block the session indefinitely; timeouts > 120s waste time.

import { toolHookInputSchema } from "./schemas.ts"
import { allowPreToolUse, denyPreToolUse } from "./utils/hook-utils.ts"

const MAX_TIMEOUT_MS = 120_000

async function main() {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())
  const toolInput = input.tool_input ?? {}
  const timeout = toolInput.timeout

  if (timeout === undefined || timeout === null) {
    denyPreToolUse(
      [
        "TaskOutput requires a `timeout` parameter (number, milliseconds).",
        "",
        "Missing timeouts block the session indefinitely waiting for output.",
        `Set timeout to at most ${MAX_TIMEOUT_MS}ms (${MAX_TIMEOUT_MS / 1000}s).`,
      ].join("\n")
    )
  }

  if (typeof timeout !== "number") {
    denyPreToolUse(
      [
        `TaskOutput \`timeout\` must be a number, got ${typeof timeout}.`,
        "",
        `Set timeout to at most ${MAX_TIMEOUT_MS}ms (${MAX_TIMEOUT_MS / 1000}s).`,
      ].join("\n")
    )
  }

  if ((timeout as number) > MAX_TIMEOUT_MS) {
    denyPreToolUse(
      [
        `TaskOutput timeout ${timeout}ms exceeds the ${MAX_TIMEOUT_MS / 1000}s maximum.`,
        "",
        `Reduce timeout to at most ${MAX_TIMEOUT_MS}ms. Long waits block the session and waste time.`,
      ].join("\n")
    )
  }

  allowPreToolUse("")
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Hook error:", e)
    process.exit(1)
  })
}
