#!/usr/bin/env bun
// PreToolUse hook: require --concurrent on bun test invocations.

import { denyPreToolUse, isShellTool } from "./hook-utils.ts"

const input = await Bun.stdin.json()
if (!isShellTool(input?.tool_name ?? "")) process.exit(0)

const command: string = input?.tool_input?.command ?? ""

// Evaluate each shell segment independently so chained commands are handled.
// Try \d>&\d? before [^|;&] so redirections like 2>&1 aren't split on &
const BUN_TEST_SEGMENT_RE = /(?:^|[|;&])\s*bun\s+test\b((?:\d>&\d?|[^|;&])*)/g
for (const segMatch of command.matchAll(BUN_TEST_SEGMENT_RE)) {
  const segment = segMatch[1] ?? ""
  const hasConcurrentFlag = /(?:^|\s)--concurrent(?:\s|=|$)/.test(segment)
  if (hasConcurrentFlag) continue

  const originalInvocation = `bun test${segment}`.trim()
  // Insert --concurrent before any trailing shell redirections
  const redirectRe = /(\s+(?:[12]?>>?|2>&1|>&)\s*\S+(?:\s+(?:[12]?>>?|2>&1|>&)\s*\S+)*)$/
  const redirectMatch = originalInvocation.match(redirectRe)
  const correctedInvocation = redirectMatch
    ? `${originalInvocation.slice(0, redirectMatch.index)} --concurrent${redirectMatch[0]}`
    : `${originalInvocation} --concurrent`
  denyPreToolUse(
    "Use `bun test` with `--concurrent`.\n\n" +
      `Blocked command:\n  ${originalInvocation}\n\n` +
      `Use this instead:\n  ${correctedInvocation}`
  )
}
