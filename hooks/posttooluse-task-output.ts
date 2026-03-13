#!/usr/bin/env bun

// PostToolUse hook: Parse TaskOutput results for failures and push context.
//
// On non-zero exit or error patterns in the output:
//   → blocks with denyPostToolUse so the agent can't silently move on.
// On successful git push output:
//   → injects the CI run ID as additionalContext so the agent can watch CI
//     without re-running the git log / gh run list dance.

import { claudeTaskOutputPath } from "../src/temp-paths.ts"
import {
  denyPostToolUse,
  emitContext,
  ghJson,
  stripAnsi,
  type ToolHookInput,
} from "./hook-utils.ts"

// ─── Types ───────────────────────────────────────────────────────────────────

interface TaskOutputResponse {
  output?: string
  status?: string
  exit_code?: number
  exitCode?: number
}

interface ExtendedToolHookInput extends ToolHookInput {
  tool_response?: TaskOutputResponse | string | null
}

interface GhRun {
  databaseId: number
  status: string
  conclusion: string | null
}

// ─── Output text extraction ──────────────────────────────────────────────────

function extractOutputText(response: TaskOutputResponse | string | null | undefined): string {
  if (!response) return ""
  if (typeof response === "string") return response
  return response.output ?? ""
}

function extractExitCode(response: TaskOutputResponse | string | null | undefined): number | null {
  if (!response || typeof response === "string") return null
  if (typeof response.exit_code === "number") return response.exit_code
  if (typeof response.exitCode === "number") return response.exitCode
  return null
}

function extractStatus(response: TaskOutputResponse | string | null | undefined): string {
  if (!response || typeof response === "string") return ""
  return response.status ?? ""
}

// ─── Failure detection ───────────────────────────────────────────────────────

/** Matches bun test failure summary line: "N fail" */
const BUN_FAIL_RE = /\b(\d+)\s+fail\b/

/**
 * Matches bun test completion marker (always the last line of output):
 *   "Ran N test(s) across M file(s). [Xs]"
 * Handles both singular and plural: "1 test across 1 file." and "3 tests across 2 files."
 * Absence means the output was truncated — counts cannot be trusted.
 */
const BUN_COMPLETE_RE = /\bRan \d+ tests? across \d+ files?\./

/**
 * Matches Jest summary line indicating test results:
 *   "Tests:       2 failed, 5 passed, 7 total"
 *   "Tests:       5 passed, 5 total"
 * Presence means Jest ran to completion (output not truncated).
 */
const JEST_COMPLETE_RE = /^Tests:\s+.+\d+ total/m

/** Matches Jest failure count: "Tests:  N failed" */
const JEST_FAIL_RE = /^Tests:\s+(\d+)\s+failed/m

/**
 * Matches Vitest summary line indicating test results:
 *   "Tests  3 passed (3)"
 *   "Tests  2 failed | 1 passed (3)"
 * The parenthetical total `(N)` is only printed when Vitest completes;
 * a truncated output may contain " Tests  N failed" without it.
 * Presence means Vitest ran to completion (output not truncated).
 */
const VITEST_COMPLETE_RE = /^ Tests\s+.*\(\d+\)/m

/** Matches Vitest failure count: " Tests  N failed" */
const VITEST_FAIL_RE = /^ Tests\s+(\d+)\s+failed/m

/**
 * Matches pytest summary line indicating test results:
 *   "== 2 failed, 5 passed in 1.23s =="
 *   "== 5 passed in 0.50s =="
 * The double-equals delimiters are only printed at the end of a full run.
 * Presence means pytest ran to completion (output not truncated).
 */
const PYTEST_COMPLETE_RE = /^=+ .+ in \d+\.\d+s =+$/m

/**
 * Detects pytest failure output (any line starting with "FAILED ").
 * Used to identify pytest output; count extraction uses PYTEST_SUMMARY_RE.
 */
const PYTEST_FAIL_RE = /^FAILED /m

/**
 * Extracts failure count from the pytest equals-bordered summary line:
 *   "== 2 failed, 5 passed in 1.23s =="
 * Only present when pytest ran to completion.
 */
const PYTEST_SUMMARY_RE = /^=+\s+(\d+)\s+failed/m

/** Matches cargo test failure: "test result: FAILED. N passed; M failed;" */
const CARGO_FAIL_RE = /^test result: FAILED\. \d+ passed; (\d+) failed;/m
/** Matches cargo test completion summary for pass/fail runs. */
const CARGO_COMPLETE_RE = /^test result: (?:ok|FAILED)\./m

/**
 * Matches go test completion line:
 *   "FAIL\tgithub.com/user/repo\t0.123s"
 *   "ok  \tgithub.com/user/repo\t0.123s"
 * The package summary line is only emitted when the test binary exits.
 * Presence means go test ran to completion (output not truncated).
 */
const GOTEST_COMPLETE_RE = /^(?:ok|FAIL)\s+\S+\s+\d+\.\d+s/m
/** Matches go test success summary line only ("ok ..."). */
const GOTEST_OK_RE = /^ok\s+\S+\s+\d+\.\d+s/m

/** Matches go test failure count from "--- FAIL:" lines */
const GOTEST_FAIL_RE = /^--- FAIL:/m

/**
 * Detects Maven Surefire output (any line containing "Tests run: N, Failures:").
 * Maven prefixes the line with "[INFO]" or "[ERROR]" depending on result.
 * Used for runner identification; count extraction uses MAVEN_SUMMARY_RE.
 */
const MAVEN_FAIL_RE = /Tests run: \d+, Failures: (\d+), Errors: (\d+)/

/**
 * Matches Maven build completion footer:
 *   "BUILD FAILURE" or "BUILD SUCCESS"
 * Only printed after the Maven lifecycle completes. Its presence means
 * output was not truncated mid-run.
 */
const MAVEN_COMPLETE_RE = /BUILD (?:FAILURE|SUCCESS)/

/**
 * Detects Gradle test failure lines: "ClassName > testName FAILED"
 * Used for runner identification; count extracted from GRADLE_SUMMARY_RE.
 */
const GRADLE_FAIL_RE = /^\S.*> \S.* FAILED$/m

/**
 * Matches Gradle test completion summary:
 *   "7 tests completed, 2 failed"
 *   "5 tests completed"
 * Always emitted after the test task finishes.
 */
const GRADLE_COMPLETE_RE = /^\d+ tests? completed/m

/** Extracts Gradle failure count from summary: "N tests completed, M failed" */
const GRADLE_SUMMARY_RE = /^\d+ tests? completed, (\d+) failed/m

/**
 * Matches RSpec summary line:
 *   "7 examples, 2 failures"
 *   "5 examples, 0 failures"
 * Always the last meaningful line of RSpec output.
 */
const RSPEC_COMPLETE_RE = /^\d+ examples?, \d+ failures?/m

/** Matches RSpec failure count: "N examples, M failures" */
const RSPEC_FAIL_RE = /^\d+ examples?, (\d+) failures?/m

/**
 * Detects dotnet test failure lines: "  Failed ClassName.TestName"
 * Used for runner identification in truncated output.
 */
const DOTNET_FAIL_RE = /^\s+Failed \S/m

/**
 * Matches dotnet test VSTest summary line:
 *   "Failed!  - Failed:     2, Passed:     5, Skipped:    0, Total:      7"
 * Always emitted at the end of a dotnet test run.
 */
const DOTNET_COMPLETE_RE = /Failed:\s+(\d+), Passed:\s+\d+.*Total:\s+\d+/

/**
 * Detects PHPUnit failure summary lines:
 *   "FAILURES!"  — test failures
 *   "ERRORS!"    — test errors
 * Only present when the full test run completes.
 */
const PHPUNIT_FAIL_RE = /^(?:FAILURES!|ERRORS!)/m

/**
 * Matches PHPUnit completion summary lines:
 *   "OK (7 tests, 14 assertions)"
 *   "FAILURES!\nTests: 7, Assertions: 10, Failures: 2."
 *   "ERRORS!\nTests: 7, Assertions: 10, Errors: 1."
 * Always the last line of PHPUnit output.
 */
const PHPUNIT_COMPLETE_RE = /^(?:OK \(\d+|Tests: \d+, Assertions: \d+)/m

/** Extracts PHPUnit failure or error count from summary line */
const PHPUNIT_COUNT_RE = /(?:Failures|Errors):\s*(\d+)/

// ─── Runner presence patterns ────────────────────────────────────────────────
// These detect that a runner was invoked even when no FAIL_RE matches (e.g.,
// compile error before any tests run). Used as a fallback in collectRunnerResults
// to attribute a non-zero exit to a specific runner.

const BUN_PRESENCE_RE = /\bbun test\b/
const JEST_PRESENCE_RE = /\bjest\b.*--/i
const VITEST_PRESENCE_RE = /\bvitest\b/i
const PYTEST_PRESENCE_RE = /^={3,} test session starts ={3,}/m
const GOTEST_PRESENCE_RE = /^=== RUN\s/m
const MAVEN_PRESENCE_RE = /\[INFO\] --- .*surefire|failsafe/i
const GRADLE_PRESENCE_RE = /> Task :.*test/
const RSPEC_PRESENCE_RE = /^Randomized with seed \d+|^Finished in \d+/m
const DOTNET_PRESENCE_RE = /^Starting test execution/m
const PHPUNIT_PRESENCE_RE = /^PHPUnit \d+/m
const CARGO_PRESENCE_RE = /^\s+running \d+ tests?$/m

/** Matches lefthook hook block indicators */
const HOOK_FAIL_RE = /🥊.*hook: (pre-push|pre-commit)|error: failed to push/i

/** Matches exit status / exit code N != 0 */
const EXIT_FAIL_RE = /exit\s+(?:status|code)\s+([1-9]\d*)/

// ─── Tool error patterns ──────────────────────────────────────────────────────

/**
 * Matches Claude Code's InputValidationError when `block` is passed as a string
 * instead of a boolean. The error arrives as the tool_response string.
 */
const BLOCK_TYPE_ERR_RE = /InputValidationError[\s\S]*\bblock\b[\s\S]*boolean/i

/**
 * Matches the "No task found" error returned when a task ID has been cleaned up
 * before the agent calls TaskOutput. Captures the ID in group 1.
 */
const TASK_NOT_FOUND_RE = /no task found with id:?\s*(\S+)/i

/** A detected failure from a single test runner within an output stream. */
type RunnerResult = {
  runner: string
  failCount: number | null // null = no numeric count available
  isComplete: boolean
  firstFailLine: string | null
  matchedFailureLines: string[]
}

const uniqueLines = (items: Array<string | null | undefined>): string[] => [
  ...new Set(items.map((item) => item?.trim()).filter((item): item is string => Boolean(item))),
]

const PASS_RESULT = (runner: string): RunnerResult => ({
  runner,
  failCount: 0,
  isComplete: true,
  firstFailLine: null,
  matchedFailureLines: [],
})

function detectBun(clean: string, lines: string[]): RunnerResult | null {
  const failMatch = clean.match(BUN_FAIL_RE)
  if (failMatch) {
    const matchedFailureLines = uniqueLines(lines.filter((l) => l.includes("✗")))
    return {
      runner: "bun",
      failCount: parseInt(failMatch[1]!, 10),
      isComplete: BUN_COMPLETE_RE.test(clean),
      firstFailLine: matchedFailureLines[0] ?? lines.find((l) => l.includes("error:")) ?? null,
      matchedFailureLines,
    }
  }
  return BUN_COMPLETE_RE.test(clean) ? PASS_RESULT("bun") : null
}

function detectJest(clean: string, lines: string[]): RunnerResult | null {
  const failMatch = clean.match(JEST_FAIL_RE)
  if (failMatch) {
    const isComplete = JEST_COMPLETE_RE.test(clean)
    const matchedFailureLines = uniqueLines(lines.filter((l) => l.startsWith("FAIL ")))
    return {
      runner: "jest",
      failCount: isComplete ? parseInt(failMatch[1]!, 10) : null,
      isComplete,
      firstFailLine: matchedFailureLines[0] ?? lines.find((l) => l.includes("●")) ?? null,
      matchedFailureLines,
    }
  }
  return JEST_COMPLETE_RE.test(clean) ? PASS_RESULT("jest") : null
}

function detectVitest(clean: string, lines: string[]): RunnerResult | null {
  const failMatch = clean.match(VITEST_FAIL_RE)
  if (failMatch) {
    const isComplete = VITEST_COMPLETE_RE.test(clean)
    const matchedFailureLines = uniqueLines(lines.filter((l) => l.match(/^\s*FAIL\s+/)))
    return {
      runner: "vitest",
      failCount: isComplete ? parseInt(failMatch[1]!, 10) : null,
      isComplete,
      firstFailLine:
        matchedFailureLines[0] ?? lines.find((l) => l.includes("AssertionError")) ?? null,
      matchedFailureLines,
    }
  }
  return VITEST_COMPLETE_RE.test(clean) ? PASS_RESULT("vitest") : null
}

function detectPytest(clean: string, lines: string[]): RunnerResult | null {
  if (PYTEST_FAIL_RE.test(clean)) {
    const isComplete = PYTEST_COMPLETE_RE.test(clean)
    const summaryMatch = clean.match(PYTEST_SUMMARY_RE)
    const matchedFailureLines = uniqueLines(lines.filter((l) => l.startsWith("FAILED ")))
    return {
      runner: "pytest",
      failCount: isComplete && summaryMatch ? parseInt(summaryMatch[1]!, 10) : null,
      isComplete,
      firstFailLine: matchedFailureLines[0] ?? null,
      matchedFailureLines,
    }
  }
  return PYTEST_COMPLETE_RE.test(clean) ? PASS_RESULT("pytest") : null
}

function detectCargo(clean: string, lines: string[]): RunnerResult | null {
  const failMatch = clean.match(CARGO_FAIL_RE)
  if (failMatch) {
    const matchedFailureLines = uniqueLines(
      lines.filter((l) => l.startsWith("---- ") || l.includes(" ... FAILED"))
    )
    return {
      runner: "cargo",
      failCount: parseInt(failMatch[1]!, 10),
      isComplete: true,
      firstFailLine: matchedFailureLines[0] ?? null,
      matchedFailureLines,
    }
  }
  return CARGO_COMPLETE_RE.test(clean) ? PASS_RESULT("cargo") : null
}

function detectGoTest(clean: string, lines: string[]): RunnerResult | null {
  if (GOTEST_FAIL_RE.test(clean)) {
    const isComplete = GOTEST_COMPLETE_RE.test(clean)
    const failCount = (clean.match(/^--- FAIL:/gm) ?? []).length
    const matchedFailureLines = uniqueLines(lines.filter((l) => l.startsWith("--- FAIL:")))
    return {
      runner: "go test",
      failCount: isComplete && failCount > 0 ? failCount : null,
      isComplete,
      firstFailLine: matchedFailureLines[0] ?? null,
      matchedFailureLines,
    }
  }
  return GOTEST_OK_RE.test(clean) ? PASS_RESULT("go test") : null
}

function detectMaven(clean: string, lines: string[]): RunnerResult | null {
  const failMatch = clean.match(MAVEN_FAIL_RE)
  if (!failMatch) return null
  const total = parseInt(failMatch[1]!, 10) + parseInt(failMatch[2]!, 10)
  const isComplete = MAVEN_COMPLETE_RE.test(clean)
  const matchedFailureLines = uniqueLines(
    lines.filter((l) => l.includes("<<< FAILURE!") || l.includes("<<< ERROR!"))
  )
  return {
    runner: "maven",
    failCount: isComplete ? total : null,
    isComplete,
    firstFailLine: matchedFailureLines[0] ?? null,
    matchedFailureLines,
  }
}

function detectGradle(clean: string, lines: string[]): RunnerResult | null {
  if (GRADLE_FAIL_RE.test(clean)) {
    const summaryMatch = clean.match(GRADLE_SUMMARY_RE)
    const isComplete = GRADLE_COMPLETE_RE.test(clean)
    const matchedFailureLines = uniqueLines(lines.filter((l) => l.match(/^\S.*> \S.* FAILED$/)))
    return {
      runner: "gradle",
      failCount: isComplete && summaryMatch ? parseInt(summaryMatch[1]!, 10) : null,
      isComplete,
      firstFailLine: matchedFailureLines[0] ?? null,
      matchedFailureLines,
    }
  }
  if (GRADLE_COMPLETE_RE.test(clean)) {
    const summaryMatch = clean.match(GRADLE_SUMMARY_RE)
    return {
      runner: "gradle",
      failCount: summaryMatch ? parseInt(summaryMatch[1]!, 10) : 0,
      isComplete: true,
      firstFailLine: null,
      matchedFailureLines: [],
    }
  }
  return null
}

function detectRspec(clean: string, lines: string[]): RunnerResult | null {
  const failMatch = clean.match(RSPEC_FAIL_RE)
  if (failMatch) {
    const isComplete = RSPEC_COMPLETE_RE.test(clean)
    const failureCount = parseInt(failMatch[1]!, 10)
    const matchedFailureLines = uniqueLines(
      lines.filter((l) => l.trim().match(/^\d+\)/) || l.includes("Failure/Error:"))
    )
    return {
      runner: "rspec",
      failCount: isComplete ? failureCount : null,
      isComplete,
      firstFailLine: failureCount > 0 ? (matchedFailureLines[0] ?? null) : null,
      matchedFailureLines: failureCount > 0 ? matchedFailureLines : [],
    }
  }
  if (clean.includes("Failure/Error:")) {
    const matchedFailureLines = uniqueLines(lines.filter((l) => l.includes("Failure/Error:")))
    return {
      runner: "rspec",
      failCount: null,
      isComplete: false,
      firstFailLine: matchedFailureLines[0] ?? null,
      matchedFailureLines,
    }
  }
  return null
}

function detectDotnet(clean: string, lines: string[]): RunnerResult | null {
  const summaryMatch = clean.match(DOTNET_COMPLETE_RE)
  if (!DOTNET_FAIL_RE.test(clean) && !summaryMatch) return null
  const matchedFailureLines = uniqueLines(lines.filter((l) => l.trim().startsWith("Failed ")))
  const failCount = summaryMatch ? parseInt(summaryMatch[1]!, 10) : null
  return {
    runner: "dotnet",
    failCount,
    isComplete: summaryMatch !== null,
    firstFailLine: failCount === 0 ? null : (matchedFailureLines[0] ?? null),
    matchedFailureLines: failCount === 0 ? [] : matchedFailureLines,
  }
}

function detectPhpunit(clean: string, lines: string[]): RunnerResult | null {
  if (PHPUNIT_FAIL_RE.test(clean)) {
    const isComplete = PHPUNIT_COMPLETE_RE.test(clean)
    const countMatch = clean.match(PHPUNIT_COUNT_RE)
    const matchedFailureLines = uniqueLines(
      lines.filter((l) => l.trim().match(/^\d+\)/) || l.includes("Error: "))
    )
    return {
      runner: "phpunit",
      failCount: isComplete && countMatch ? parseInt(countMatch[1]!, 10) : null,
      isComplete,
      firstFailLine: matchedFailureLines[0] ?? null,
      matchedFailureLines,
    }
  }
  return PHPUNIT_COMPLETE_RE.test(clean) ? PASS_RESULT("phpunit") : null
}

const RUNNER_DETECTORS: Array<(clean: string, lines: string[]) => RunnerResult | null> = [
  detectBun,
  detectJest,
  detectVitest,
  detectPytest,
  detectCargo,
  detectGoTest,
  detectMaven,
  detectGradle,
  detectRspec,
  detectDotnet,
  detectPhpunit,
]

const PRESENCE_CHECKS: Array<{ runner: string; re: RegExp; errorHint: string }> = [
  { runner: "bun", re: BUN_PRESENCE_RE, errorHint: "error:" },
  { runner: "jest", re: JEST_PRESENCE_RE, errorHint: "Error:" },
  { runner: "vitest", re: VITEST_PRESENCE_RE, errorHint: "Error:" },
  { runner: "pytest", re: PYTEST_PRESENCE_RE, errorHint: "ERROR " },
  { runner: "cargo", re: CARGO_PRESENCE_RE, errorHint: "error[" },
  { runner: "go test", re: GOTEST_PRESENCE_RE, errorHint: "Error" },
  { runner: "maven", re: MAVEN_PRESENCE_RE, errorHint: "ERROR" },
  { runner: "gradle", re: GRADLE_PRESENCE_RE, errorHint: "FAILED" },
  { runner: "rspec", re: RSPEC_PRESENCE_RE, errorHint: "Error:" },
  { runner: "dotnet", re: DOTNET_PRESENCE_RE, errorHint: "Error" },
  { runner: "phpunit", re: PHPUNIT_PRESENCE_RE, errorHint: "Error" },
]

function collectPresenceFallbacks(
  clean: string,
  lines: string[],
  detected: Set<string>
): RunnerResult[] {
  const results: RunnerResult[] = []
  for (const { runner, re, errorHint } of PRESENCE_CHECKS) {
    if (detected.has(runner) || !re.test(clean)) continue
    const matchedFailureLines = uniqueLines(
      lines.filter((l) => l.toLowerCase().includes(errorHint.toLowerCase()))
    )
    results.push({
      runner,
      failCount: null,
      isComplete: false,
      firstFailLine: matchedFailureLines[0] ?? null,
      matchedFailureLines,
    })
  }
  return results
}

/**
 * Collect RunnerResult entries for every test runner whose FAIL_RE matches `clean`.
 * All runners are checked — no early return — so composite multi-runner output is
 * handled correctly when multiple runners write to the same output stream.
 */
function collectRunnerResults(clean: string, lines: string[]): RunnerResult[] {
  const results: RunnerResult[] = []
  for (const detect of RUNNER_DETECTORS) {
    const result = detect(clean, lines)
    if (result) results.push(result)
  }
  const detected = new Set(results.map((r) => r.runner))
  results.push(...collectPresenceFallbacks(clean, lines, detected))
  return results
}

/**
 * Format a failure message from one or more RunnerResult entries.
 * Single-runner output preserves the existing message format exactly.
 * Multi-runner composite output aggregates counts across all runners,
 * preserving concrete counts when mixed with presence-only fallbacks.
 */
function formatRunnerFailure(results: RunnerResult[], exitCode: number): string {
  if (results.length === 1) {
    const r = results[0]!
    // For a single incomplete runner, avoid presenting partial tallies as exact.
    const countLabel =
      r.failCount === null || !r.isComplete ? "unknown number of" : `${r.failCount}`
    const detail = r.firstFailLine ? `\n\nFirst failure: ${r.firstFailLine.trim()}` : ""
    return `${countLabel} test(s) failed (exit code ${exitCode}).${detail}\n\nRun the failing tests locally to diagnose before proceeding.`
  }

  // Composite: aggregate across all runners.
  // Incomplete runners with concrete counts are lower bounds, not exact totals.
  const concrete = results.filter((r) => r.failCount !== null)
  const hasPresenceOnly = results.some((r) => r.failCount === null)
  const hasIncompleteConcrete = concrete.some((r) => !r.isComplete)
  const concreteFails = concrete.reduce((sum, r) => sum + r.failCount!, 0)
  const matchedFailureLineCount = new Set(
    results.flatMap((r) => r.matchedFailureLines.map((line) => line.trim()))
  ).size

  let countLabel: string
  if (concrete.length === 0) {
    // All presence-only: use distinct matched failure lines when available.
    countLabel = matchedFailureLineCount > 0 ? `${matchedFailureLineCount}` : "unknown number of"
  } else if (hasPresenceOnly || hasIncompleteConcrete) {
    // Mix includes unknown contribution or incomplete tallies: lower bound only.
    countLabel = `${concreteFails}+`
  } else {
    // All runners have concrete, complete counts — sum is exact
    countLabel = `${concreteFails}`
  }
  const runnerNames = results.map((r) => r.runner).join(", ")
  const firstFailLine = results.find((r) => r.firstFailLine)?.firstFailLine ?? null
  const detail = firstFailLine ? `\n\nFirst failure: ${firstFailLine.trim()}` : ""
  return `${countLabel} test(s) failed across multiple runners (${runnerNames}) (exit code ${exitCode}).${detail}\n\nRun the failing tests locally to diagnose before proceeding.`
}

function detectFailure(output: string, exitCode: number | null): string | null {
  // Normalize once — all pattern matching below operates on ANSI-free text.
  const clean = stripAnsi(output)

  // Non-zero exit code is the primary signal
  if (exitCode !== null && exitCode !== 0) {
    // Try to surface the most actionable line from the output
    const lines = clean.split("\n").filter((l) => l.trim())

    // Collect results from all matching runners (no short-circuit — supports composite output)
    const runnerResults = collectRunnerResults(clean, lines)
    if (runnerResults.length > 0) {
      return formatRunnerFailure(runnerResults, exitCode)
    }

    // Push / hook failures
    if (HOOK_FAIL_RE.test(clean)) {
      const hookName = clean.match(/hook: (\S+)/)?.[1] ?? "pre-push"
      const errorLine = lines.find((l) => l.includes("error:") || l.includes("✗"))
      const detail = errorLine ? `\n\nFailing check: ${errorLine.trim()}` : ""
      return `${hookName} hook blocked the operation (exit code ${exitCode}).${detail}\n\nFix the underlying issue — do not bypass hooks.`
    }

    // Generic non-zero exit
    const errorLine = lines.find((l) => l.toLowerCase().includes("error") || EXIT_FAIL_RE.test(l))
    const detail = errorLine ? `\n\nError: ${errorLine.trim()}` : ""
    return `Background task exited with code ${exitCode}.${detail}\n\nDo not proceed until this failure is resolved.`
  }

  // Even with exit 0, some tools print error patterns (rare but happens with gh CLI)
  if (exitCode === null && EXIT_FAIL_RE.test(clean)) {
    const code = clean.match(EXIT_FAIL_RE)?.[1]
    return `Output contains exit status ${code}. Verify the task actually succeeded before continuing.`
  }

  return null
}

// ─── Fallback output-file recovery ───────────────────────────────────────────

/**
 * When a task record has been cleaned up (the agent held the ID too long),
 * Claude Code returns "No task found with ID: <id>" instead of the task output.
 * The output file itself persists at a predictable path — try to read it directly.
 *
 * Path: /tmp/claude-{uid}/{cwd-encoded}/tasks/{taskId}.output
 * where cwd-encoded uses `cwd.replace(/[/.]/g, "-")` (same encoding as Claude Code).
 */
async function tryReadOutputFile(taskId: string, cwd: string): Promise<string | null> {
  try {
    const uid = process.getuid?.() ?? 501
    const cwdKey = cwd.replace(/[/.]/g, "-")
    const filePath = claudeTaskOutputPath(uid, cwdKey, taskId)
    const file = Bun.file(filePath)
    if (!(await file.exists())) return null
    return await file.text()
  } catch {
    return null
  }
}

// ─── Git push success detection ──────────────────────────────────────────────

/** Matches: "abc1234..def5678  main -> main" or "To https://github.com/..." */
const PUSH_SHA_RE = /([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})\s+\S+\s*->\s*\S+/
const PUSH_REMOTE_RE = /To https?:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\s/

async function buildCiContext(output: string, cwd: string): Promise<string | null> {
  const shaMatch = output.match(PUSH_SHA_RE)
  if (!shaMatch) return null

  const pushedSha = shaMatch[2] // the new HEAD after push
  if (!pushedSha) return null

  const repoMatch = output.match(PUSH_REMOTE_RE)

  // Give GitHub a moment to register the push before querying
  await new Promise((r) => setTimeout(r, 2000))

  const runs = await ghJson<GhRun[]>(
    [
      "run",
      "list",
      "--commit",
      pushedSha,
      "--json",
      "databaseId,status,conclusion",
      "--limit",
      "3",
    ],
    cwd
  )

  if (!runs || runs.length === 0) {
    const repoHint = repoMatch ? ` (${repoMatch[1]})` : ""
    return (
      `Push succeeded${repoHint}. Pushed SHA: ${pushedSha}\n` +
      `No CI run found yet for this SHA — it may still be queuing. ` +
      `Run: gh run list --commit ${pushedSha} --json databaseId --jq '.[0].databaseId'`
    )
  }

  const run = runs[0]!
  const lines: string[] = [
    `Push succeeded. SHA: ${pushedSha} | CI run: ${run.databaseId} | status: ${run.status}`,
    `Watch: gh run watch ${run.databaseId} --exit-status`,
    `Verify: gh run view ${run.databaseId} --json conclusion,status,jobs --jq '{conclusion,status,jobs:[.jobs[]|{name,conclusion,status}]}'`,
  ]

  return lines.join("\n")
}

// ─── Main ────────────────────────────────────────────────────────────────────

const input = (await Bun.stdin.json().catch(() => null)) as ExtendedToolHookInput | null
if (!input) process.exit(0)

if (input.tool_name !== "TaskOutput") process.exit(0)

const response = input.tool_response ?? null

// ─── Tool error handling ──────────────────────────────────────────────────────
// Claude Code delivers InputValidationError and "No task found" as plain strings.
// Handle them before the normal structured-response path.
if (typeof response === "string") {
  // Case 1: block was passed as a string — surface a clear type correction.
  if (BLOCK_TYPE_ERR_RE.test(response)) {
    denyPostToolUse(
      "`TaskOutput` call failed: the `block` parameter must be a boolean (`true`/`false`), not a string.\n\n" +
        'Fix: pass `block: true` (boolean) — never `block: "true"` (string).'
    )
  }

  // Case 2: task record cleaned up — attempt fallback read from output file.
  // This entire block only runs when the record is already gone (TASK_NOT_FOUND_RE matched).
  // There is no "record exists but file missing" case here — the output file is only
  // consulted as a fallback when the record has been garbage-collected.
  //
  // All branches below exit via denyPostToolUse/emitContext (both return never).
  // The denyPostToolUse at the bottom is the catch-all for: taskId empty, or file missing.
  const notFoundMatch = response.match(TASK_NOT_FOUND_RE)
  if (notFoundMatch) {
    const taskId = String(input.tool_input?.task_id ?? notFoundMatch[1] ?? "")
    const recovered = taskId ? await tryReadOutputFile(taskId, input.cwd ?? process.cwd()) : null
    if (recovered) {
      const failureReason = detectFailure(recovered, null)
      if (failureReason) {
        // Record gone + file found + failure detected → block with recovered failure detail.
        denyPostToolUse(
          `Task \`${taskId}\` output (recovered from file — record had expired):\n\n${failureReason}`
        )
      }
      // Record gone + file found + no failure → inject recovered content as context.
      await emitContext(
        "PostToolUse",
        `Task \`${taskId}\` output recovered from file (record had expired).\n` +
          `Output preview:\n${recovered.slice(0, 500)}`,
        input.cwd ?? process.cwd()
      )
    }
    // Record gone + taskId empty OR record gone + file missing → block with actionable message.
    denyPostToolUse(
      `Task \`${notFoundMatch[1]}\` output unavailable: the task record has been garbage-collected and no output file was found.\n\n` +
        `The task completed (or was cleaned up) before its output could be read. ` +
        `Check recent git log or CI status to determine whether the task succeeded.`
    )
  }
}

const taskStatus = extractStatus(response)

// Only process completed tasks — skip if still in-progress
if (taskStatus === "in_progress" || taskStatus === "running") process.exit(0)

const output = extractOutputText(response)
const exitCode = extractExitCode(response)

// ── Failure path ─────────────────────────────────────────────────────────────
const failureReason = detectFailure(output, exitCode)
if (failureReason) {
  denyPostToolUse(failureReason)
}

// ── Success path: detect git push and inject CI context ──────────────────────
if (!output.includes("To https://") && !PUSH_SHA_RE.test(output)) process.exit(0)

const ciContext = await buildCiContext(output, input.cwd ?? process.cwd())
if (!ciContext) process.exit(0)

await emitContext("PostToolUse", ciContext, input.cwd ?? process.cwd())
