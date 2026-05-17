#!/usr/bin/env bun

/**
 * PreToolUse hook: Enforce --concurrent policy on bun test invocations.
 *
 * - Multi-file / general: MUST use --concurrent
 * - Single specific file: MUST NOT use --concurrent
 *
 * Dual-mode: exports a SwizShellHook for inline dispatch and remains
 * executable as a standalone script for backwards compatibility and testing.
 */
import { bunTestArgSegments, isSingleFileBunTestArgs } from "../src/command-utils.ts"
import { runSwizHookAsMain, type SwizShellHook } from "../src/SwizHook.ts"
import type { ShellHookInput } from "../src/schemas.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { preToolUseAllow, preToolUseDeny } from "../src/utils/hook-utils.ts"

function denySingleFileConcurrent(segment: string) {
  const originalInvocation = `bun test${segment}`.trim()
  const correctedInvocation = originalInvocation
    .replace(/\s+--concurrent(?:=\S+)?/, "")
    .replace(/\s{2,}/g, " ")
    .trim()
  return preToolUseDeny(
    "Don't use `--concurrent` when testing a single file.\n\n" +
      `Blocked command:\n  ${originalInvocation}\n\n` +
      `Use this instead:\n  ${correctedInvocation}`
  )
}

function denyMissingConcurrent(segment: string) {
  const originalInvocation = `bun test${segment}`.trim()
  const redirectRe = /(\s+(?:[12]?>>?|2>&1|>&)\s*\S+(?:\s+(?:[12]?>>?|2>&1|>&)\s*\S+)*)$/
  const redirectMatch = originalInvocation.match(redirectRe)
  const correctedInvocation = redirectMatch
    ? `${originalInvocation.slice(0, redirectMatch.index)} --concurrent${redirectMatch[0]}`
    : `${originalInvocation} --concurrent`
  return preToolUseDeny(
    "Use `bun test` with `--concurrent`.\n\n" +
      `Blocked command:\n  ${originalInvocation}\n\n` +
      `Use this instead:\n  ${correctedInvocation}`
  )
}

function evaluateBunTestSegment(segment: string) {
  const hasConcurrentFlag = /(?:^|\s)--concurrent(?:\s|=|$)/.test(segment)
  const singleFile = isSingleFileBunTestArgs(segment)

  if (singleFile && hasConcurrentFlag) return denySingleFileConcurrent(segment)
  if (singleFile || hasConcurrentFlag) return null
  return denyMissingConcurrent(segment)
}

function evaluate(input: ShellHookInput) {
  // In standalone mode the matcher isn't applied, so guard on tool name.
  if (!isShellTool(input.tool_name ?? "")) return {}

  const command: string = input.tool_input?.command ?? ""

  for (const segment of bunTestArgSegments(command)) {
    const violation = evaluateBunTestSegment(segment)
    if (violation) return violation
  }
  return preToolUseAllow(
    "Continue in concurrent Bun test mode: multi-file runs include --concurrent and single-file runs stay focused."
  )
}

const pretooluseBunTestConcurrent: SwizShellHook = {
  name: "pretooluse-bun-test-concurrent",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 5,

  run(input) {
    return evaluate(input as ShellHookInput)
  },
}

export default pretooluseBunTestConcurrent

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretooluseBunTestConcurrent)
