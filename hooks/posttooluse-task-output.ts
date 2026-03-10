#!/usr/bin/env bun
// PostToolUse hook: Parse TaskOutput results for failures and push context.
//
// On non-zero exit or error patterns in the output:
//   → blocks with denyPostToolUse so the agent can't silently move on.
// On successful git push output:
//   → injects the CI run ID as additionalContext so the agent can watch CI
//     without re-running the git log / gh run list dance.

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

/**
 * Matches cargo test completion line:
 *   "test result: FAILED. 1 passed; 2 failed; 0 ignored;"
 *   "test result: ok. 5 passed; 0 failed;"
 * Always the last line of a cargo test run.
 */
const CARGO_COMPLETE_RE = /^test result: (?:ok|FAILED)\./m

/** Matches cargo test failure: "test result: FAILED. N passed; M failed;" */
const CARGO_FAIL_RE = /^test result: FAILED\. \d+ passed; (\d+) failed;/m

/**
 * Matches go test completion line:
 *   "FAIL\tgithub.com/user/repo\t0.123s"
 *   "ok  \tgithub.com/user/repo\t0.123s"
 * The package summary line is only emitted when the test binary exits.
 * Presence means go test ran to completion (output not truncated).
 */
const GOTEST_COMPLETE_RE = /^(?:ok|FAIL)\s+\S+\s+\d+\.\d+s/m

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

function detectFailure(output: string, exitCode: number | null): string | null {
  // Normalize once — all pattern matching below operates on ANSI-free text.
  const clean = stripAnsi(output)

  // Non-zero exit code is the primary signal
  if (exitCode !== null && exitCode !== 0) {
    // Try to surface the most actionable line from the output
    const lines = clean.split("\n").filter((l) => l.trim())

    // Bun test failures
    const bunFailMatch = clean.match(BUN_FAIL_RE)
    if (bunFailMatch) {
      // Only claim an exact count when the bun completion marker is present.
      // Its absence means output was truncated — report "unknown" instead.
      const isComplete = BUN_COMPLETE_RE.test(clean)
      const countLabel = isComplete ? `${bunFailMatch[1]}` : "unknown number of"
      // Find first ✗ failure line for context
      const failLine = lines.find((l) => l.includes("✗") || l.includes("error:"))
      const detail = failLine ? `\n\nFirst failure: ${failLine.trim()}` : ""
      return `${countLabel} test(s) failed (exit code ${exitCode}).${detail}\n\nRun the failing tests locally to diagnose before proceeding.`
    }

    // Jest test failures
    const jestFailMatch = clean.match(JEST_FAIL_RE)
    if (jestFailMatch) {
      const isComplete = JEST_COMPLETE_RE.test(clean)
      const countLabel = isComplete ? `${jestFailMatch[1]}` : "unknown number of"
      const failLine = lines.find((l) => l.includes("FAIL") || l.includes("●"))
      const detail = failLine ? `\n\nFirst failure: ${failLine.trim()}` : ""
      return `${countLabel} test(s) failed (exit code ${exitCode}).${detail}\n\nRun the failing tests locally to diagnose before proceeding.`
    }

    // Vitest test failures
    const vitestFailMatch = clean.match(VITEST_FAIL_RE)
    if (vitestFailMatch) {
      const isComplete = VITEST_COMPLETE_RE.test(clean)
      const countLabel = isComplete ? `${vitestFailMatch[1]}` : "unknown number of"
      const failLine = lines.find((l) => l.includes("FAIL") || l.includes("AssertionError"))
      const detail = failLine ? `\n\nFirst failure: ${failLine.trim()}` : ""
      return `${countLabel} test(s) failed (exit code ${exitCode}).${detail}\n\nRun the failing tests locally to diagnose before proceeding.`
    }

    // pytest failures
    if (PYTEST_FAIL_RE.test(clean)) {
      const isComplete = PYTEST_COMPLETE_RE.test(clean)
      const summaryMatch = clean.match(PYTEST_SUMMARY_RE)
      const countLabel = isComplete && summaryMatch ? `${summaryMatch[1]}` : "unknown number of"
      const failLine = lines.find((l) => l.startsWith("FAILED "))
      const detail = failLine ? `\n\nFirst failure: ${failLine.trim()}` : ""
      return `${countLabel} test(s) failed (exit code ${exitCode}).${detail}\n\nRun the failing tests locally to diagnose before proceeding.`
    }

    // cargo test failures
    const cargoFailMatch = clean.match(CARGO_FAIL_RE)
    if (cargoFailMatch) {
      // CARGO_COMPLETE_RE and CARGO_FAIL_RE are both on the same line — if FAIL_RE matched, run is complete
      const countLabel = `${cargoFailMatch[1]}`
      const failLine = lines.find((l) => l.includes("FAILED") || l.startsWith("---- "))
      const detail = failLine ? `\n\nFirst failure: ${failLine.trim()}` : ""
      return `${countLabel} test(s) failed (exit code ${exitCode}).${detail}\n\nRun the failing tests locally to diagnose before proceeding.`
    }
    // cargo test run completed with non-zero exit but no FAILED result line (e.g. compile error)
    if (CARGO_COMPLETE_RE.test(clean)) {
      const failLine = lines.find((l) => l.toLowerCase().includes("error"))
      const detail = failLine ? `\n\nError: ${failLine.trim()}` : ""
      return `Background task exited with code ${exitCode}.${detail}\n\nDo not proceed until this failure is resolved.`
    }

    // go test failures — count "--- FAIL:" occurrences as a proxy for failed test count
    if (GOTEST_FAIL_RE.test(clean)) {
      const isComplete = GOTEST_COMPLETE_RE.test(clean)
      const failCount = (clean.match(/^--- FAIL:/gm) ?? []).length
      const countLabel = isComplete && failCount > 0 ? `${failCount}` : "unknown number of"
      const failLine = lines.find((l) => l.startsWith("--- FAIL:"))
      const detail = failLine ? `\n\nFirst failure: ${failLine.trim()}` : ""
      return `${countLabel} test(s) failed (exit code ${exitCode}).${detail}\n\nRun the failing tests locally to diagnose before proceeding.`
    }

    // Maven Surefire/Failsafe failures
    const mavenFailMatch = clean.match(MAVEN_FAIL_RE)
    if (mavenFailMatch) {
      // Failures + Errors both count as test failures
      const failures = parseInt(mavenFailMatch[1]!, 10)
      const errors = parseInt(mavenFailMatch[2]!, 10)
      const total = failures + errors
      const isComplete = MAVEN_COMPLETE_RE.test(clean)
      const countLabel = isComplete && total > 0 ? `${total}` : "unknown number of"
      const failLine = lines.find((l) => l.includes("<<< FAILURE!") || l.includes("<<< ERROR!"))
      const detail = failLine ? `\n\nFirst failure: ${failLine.trim()}` : ""
      return `${countLabel} test(s) failed (exit code ${exitCode}).${detail}\n\nRun the failing tests locally to diagnose before proceeding.`
    }

    // Gradle test failures
    if (GRADLE_FAIL_RE.test(clean)) {
      const summaryMatch = clean.match(GRADLE_SUMMARY_RE)
      const isComplete = GRADLE_COMPLETE_RE.test(clean)
      const countLabel = isComplete && summaryMatch ? `${summaryMatch[1]}` : "unknown number of"
      const failLine = lines.find((l) => l.match(/^\S.*> \S.* FAILED$/))
      const detail = failLine ? `\n\nFirst failure: ${failLine.trim()}` : ""
      return `${countLabel} test(s) failed (exit code ${exitCode}).${detail}\n\nRun the failing tests locally to diagnose before proceeding.`
    }

    // RSpec failures
    const rspecFailMatch = clean.match(RSPEC_FAIL_RE)
    if (rspecFailMatch && parseInt(rspecFailMatch[1]!, 10) > 0) {
      const isComplete = RSPEC_COMPLETE_RE.test(clean)
      const countLabel = isComplete ? `${rspecFailMatch[1]}` : "unknown number of"
      const failLine = lines.find((l) => l.trim().match(/^\d+\)/) || l.includes("Failure/Error:"))
      const detail = failLine ? `\n\nFirst failure: ${failLine.trim()}` : ""
      return `${countLabel} test(s) failed (exit code ${exitCode}).${detail}\n\nRun the failing tests locally to diagnose before proceeding.`
    }
    // RSpec truncated: has "Failure/Error:" but no summary line yet
    if (clean.includes("Failure/Error:")) {
      const failLine = lines.find((l) => l.includes("Failure/Error:"))
      const detail = failLine ? `\n\nFirst failure: ${failLine.trim()}` : ""
      return `unknown number of test(s) failed (exit code ${exitCode}).${detail}\n\nRun the failing tests locally to diagnose before proceeding.`
    }

    // dotnet test failures
    if (DOTNET_FAIL_RE.test(clean)) {
      const summaryMatch = clean.match(DOTNET_COMPLETE_RE)
      const isComplete = summaryMatch !== null
      const countLabel = isComplete ? `${summaryMatch![1]}` : "unknown number of"
      const failLine = lines.find((l) => l.trim().startsWith("Failed "))
      const detail = failLine ? `\n\nFirst failure: ${failLine.trim()}` : ""
      return `${countLabel} test(s) failed (exit code ${exitCode}).${detail}\n\nRun the failing tests locally to diagnose before proceeding.`
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
    const filePath = `/tmp/claude-${uid}/${cwdKey}/tasks/${taskId}.output`
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
    if (taskId) {
      const recovered = await tryReadOutputFile(taskId, input.cwd ?? process.cwd())
      if (recovered) {
        const failureReason = detectFailure(recovered, null)
        if (failureReason) {
          // Record gone + file found + failure detected → block with recovered failure detail.
          denyPostToolUse(
            `Task \`${taskId}\` output (recovered from file — record had expired):\n\n${failureReason}`
          )
        }
        // Record gone + file found + no failure → inject recovered content as context.
        emitContext(
          "PostToolUse",
          `Task \`${taskId}\` output recovered from file (record had expired).\n` +
            `Output preview:\n${recovered.slice(0, 500)}`,
          input.cwd ?? process.cwd()
        )
      }
      // Record gone + file missing → fall through to denyPostToolUse below.
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

emitContext("PostToolUse", ciContext, input.cwd ?? process.cwd())
