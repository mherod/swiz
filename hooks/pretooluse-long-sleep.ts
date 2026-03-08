#!/usr/bin/env bun

import { allowPreToolUse, denyPreToolUse } from "./hook-utils.ts"
import { shellHookInputSchema } from "./schemas.ts"

async function main() {
  const input = shellHookInputSchema.parse(await Bun.stdin.json())

  const command = input.tool_input?.command || ""

  // Detect sleep commands with durations >= 30 seconds
  const sleepMatch = command.match(/sleep\s+(\d+)/)
  if (sleepMatch) {
    const duration = parseInt(sleepMatch[1] ?? "0", 10)

    if (duration >= 30) {
      const reason = [
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

      denyPreToolUse(reason)
    }
  }

  allowPreToolUse("")
}

main().catch((e) => {
  console.error("Hook error:", e)
  process.exit(1)
})
