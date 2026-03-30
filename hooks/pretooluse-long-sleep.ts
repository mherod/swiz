#!/usr/bin/env bun
/**
 * PreToolUse hook: Block `sleep` commands with durations >= 30 seconds.
 *
 * Dual-mode: exports a SwizShellHook for inline dispatch and remains
 * executable as a standalone script for backwards compatibility and testing.
 */

import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizShellHook,
} from "../src/SwizHook.ts"
import type { ShellHookInput } from "./schemas.ts"

function evaluate(input: ShellHookInput) {
  const command = input.tool_input?.command || ""

  const sleepMatch = command.match(/sleep\s+(\d+)/)
  if (!sleepMatch) return preToolUseAllow("")

  const duration = parseInt(sleepMatch[1] ?? "0", 10)
  if (duration < 30) return preToolUseAllow("")

  return preToolUseDeny(
    [
      `Do not use \`sleep ${duration}\`—long delays block and waste time.`,
      "",
      "Instead, use one of these patterns:",
      "  • Poll with timeout: `timeout 120 bash -c 'while ! condition; do sleep 2; done'`",
      "  • Wait for process: `wait $pid` (if you have the PID)",
      "  • Check service: `timeout 30 bash -c 'until curl -s http://localhost:3000; do sleep 1; done'`",
      "  • Background execution: `cmd1 & cmd2 & wait` (run in parallel)",
      "  • Stream logs: `npm run build && tail -f logs/* &` (watch progress)",
      "",
      "All of these avoid wasting time with long static delays.",
    ].join("\n")
  )
}

const pretooluseLongSleep: SwizShellHook = {
  name: "pretooluse-long-sleep",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 5,

  run(input) {
    return evaluate(input as ShellHookInput)
  },
}

export default pretooluseLongSleep

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretooluseLongSleep)
