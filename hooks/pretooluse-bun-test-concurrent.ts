#!/usr/bin/env bun

/**
 * PreToolUse hook: Enforce bounded file-level parallelism for Bun tests.
 *
 * - Multi-file / general: MUST use --parallel=<1-8>
 * - Single specific file: MUST NOT use --parallel or --concurrent
 * - --concurrent is always blocked because it marks every test concurrent
 *
 * Dual-mode: exports a SwizShellHook for inline dispatch and remains
 * executable as a standalone script for backwards compatibility and testing.
 */
import { bunTestArgSegments, isSingleFileBunTestArgs } from "../src/command-utils.ts"
import { runSwizHookAsMain, type SwizShellHook } from "../src/SwizHook.ts"
import type { ShellHookInput } from "../src/schemas.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { preToolUseAllow, preToolUseDeny } from "../src/utils/hook-utils.ts"

function removeFlag(invocation: string, flag: "concurrent" | "parallel"): string {
  return invocation
    .replace(new RegExp(`\\s+--${flag}(?:[=\\s]+\\d+)?`, "g"), "")
    .replace(/\s{2,}/g, " ")
    .trim()
}

function denyConcurrent(segment: string, singleFile: boolean) {
  const originalInvocation = `bun test${segment}`.trim()
  const withoutConcurrent = removeFlag(originalInvocation, "concurrent")
  const correctedInvocation = singleFile ? withoutConcurrent : `${withoutConcurrent} --parallel=4`
  return preToolUseDeny(
    "`--concurrent` makes every test concurrent and overloads process-heavy suites.\n\n" +
      `Blocked command:\n  ${originalInvocation}\n\n` +
      `Use this instead:\n  ${correctedInvocation}`
  )
}

function denySingleFileParallel(segment: string) {
  const originalInvocation = `bun test${segment}`.trim()
  return preToolUseDeny(
    "A single test file does not need worker processes.\n\n" +
      `Blocked command:\n  ${originalInvocation}\n\n` +
      `Use this instead:\n  ${removeFlag(originalInvocation, "parallel")}`
  )
}

function denyInvalidParallel(segment: string) {
  const originalInvocation = `bun test${segment}`.trim()
  const correctedInvocation = `${removeFlag(originalInvocation, "parallel")} --parallel=4`
  return preToolUseDeny(
    "Use an explicit bounded worker count between 1 and 8.\n\n" +
      `Blocked command:\n  ${originalInvocation}\n\n` +
      `Use this instead:\n  ${correctedInvocation}`
  )
}

function denyMissingParallel(segment: string) {
  const originalInvocation = `bun test${segment}`.trim()
  const redirectRe = /(\s+(?:[12]?>>?|2>&1|>&)\s*\S+(?:\s+(?:[12]?>>?|2>&1|>&)\s*\S+)*)$/
  const redirectMatch = originalInvocation.match(redirectRe)
  const correctedInvocation = redirectMatch
    ? `${originalInvocation.slice(0, redirectMatch.index)} --parallel=4${redirectMatch[0]}`
    : `${originalInvocation} --parallel=4`
  return preToolUseDeny(
    "Use bounded file-level workers for multi-file Bun tests.\n\n" +
      `Blocked command:\n  ${originalInvocation}\n\n` +
      `Use this instead:\n  ${correctedInvocation}`
  )
}

function evaluateBunTestSegment(segment: string) {
  const hasConcurrentFlag = /(?:^|\s)--concurrent(?:\s|=|$)/.test(segment)
  const parallelMatch = segment.match(/(?:^|\s)--parallel(?:=|\s+)(\d+)(?:\s|$)/)
  const hasParallelFlag = /(?:^|\s)--parallel(?:\s|=|$)/.test(segment)
  const parallelWorkers = parallelMatch ? Number(parallelMatch[1]) : null
  const singleFile = isSingleFileBunTestArgs(segment)

  if (hasConcurrentFlag) return denyConcurrent(segment, singleFile)
  if (singleFile && hasParallelFlag) return denySingleFileParallel(segment)
  if (singleFile) return null
  if (parallelWorkers === null || parallelWorkers < 1 || parallelWorkers > 8) {
    return hasParallelFlag ? denyInvalidParallel(segment) : denyMissingParallel(segment)
  }
  return null
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
    "Continue with bounded Bun test workers: multi-file runs use --parallel=<1-8> and single-file runs stay focused."
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
