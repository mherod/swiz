#!/usr/bin/env bun
// PreToolUse hook: require --concurrent on bun test invocations.

import { denyPreToolUse, isShellTool } from "./hook-utils.ts"

const input = await Bun.stdin.json()
if (!isShellTool(input?.tool_name ?? "")) process.exit(0)

const command: string = input?.tool_input?.command ?? ""

// Evaluate each shell segment independently so chained commands are handled.
const BUN_TEST_SEGMENT_RE = /(?:^|[|;&])\s*bun\s+test\b([^|;&]*)/g
for (const segMatch of command.matchAll(BUN_TEST_SEGMENT_RE)) {
  const segment = segMatch[1] ?? ""
  const hasConcurrentFlag = /(?:^|\s)--concurrent(?:\s|=|$)/.test(segment)
  if (hasConcurrentFlag) continue

  const originalInvocation = `bun test${segment}`.trim()
  const correctedInvocation = `${originalInvocation} --concurrent`.trim()
  denyPreToolUse(
    "Use `bun test` with `--concurrent`.\n\n" +
      `Blocked command:\n  ${originalInvocation}\n\n` +
      `Use this instead:\n  ${correctedInvocation}`
  )
}
