#!/usr/bin/env bun
// PreToolUse hook: require --concurrent on bun test invocations.

import { allowPreToolUse, denyPreToolUse, isShellTool } from "../src/utils/hook-utils.ts"
import { SHELL_SEGMENT_BOUNDARY } from "../src/utils/shell-patterns.ts"

const input = await Bun.stdin.json()
if (!isShellTool(input?.tool_name ?? "")) process.exit(0)

const command: string = input?.tool_input?.command ?? ""

// Evaluate each shell segment independently so chained commands are handled.
// Try \d>&\d? before [^|;&] so redirections like 2>&1 aren't split on &
const BUN_TEST_SEGMENT_RE = new RegExp(
  `${SHELL_SEGMENT_BOUNDARY}\\s*bun\\s+test\\b((?:\\d>&\\d?|[^|;&])*)`,
  "g"
)
// Matches a test/spec file path (e.g., "src/foo.test.ts", "./hooks/bar.spec.js")
const TEST_FILE_RE = /(?:\.\/)?[\w./-]+\.(?:test|spec)\.\w+/

/** Returns true when the segment targets exactly one test file (no dirs/globs). */
function isSingleFileTest(segment: string): boolean {
  // Strip flags (--flag, --flag=val) and redirections to get positional args
  const stripped = segment
    .replace(/\s+--\w[\w-]*(?:=\S*)?/g, "") // flags
    .replace(/\s*(?:[12]?>>?|2>&1|>&)\s*\S+/g, "") // redirections
    .trim()
  // Split remaining tokens — these are positional args (file paths, dirs)
  const positionals = stripped.split(/\s+/).filter(Boolean)
  return positionals.length === 1 && TEST_FILE_RE.test(positionals[0] ?? "")
}

for (const segMatch of command.matchAll(BUN_TEST_SEGMENT_RE)) {
  const segment = segMatch[1] ?? ""
  const hasConcurrentFlag = /(?:^|\s)--concurrent(?:\s|=|$)/.test(segment)
  if (hasConcurrentFlag) continue

  // Single test file — --concurrent is unnecessary
  if (isSingleFileTest(segment)) continue

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
allowPreToolUse("All bun test invocations have --concurrent or target single files")
