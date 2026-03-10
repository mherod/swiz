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
    const failMatch = clean.match(BUN_FAIL_RE)
    if (failMatch) {
      // Only claim an exact count when the bun completion marker is present.
      // Its absence means output was truncated — report "unknown" instead.
      const isComplete = BUN_COMPLETE_RE.test(clean)
      const countLabel = isComplete ? `${failMatch[1]}` : "unknown number of"
      // Find first ✗ failure line for context
      const failLine = lines.find((l) => l.includes("✗") || l.includes("error:"))
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
  const notFoundMatch = response.match(TASK_NOT_FOUND_RE)
  if (notFoundMatch) {
    const taskId = String(input.tool_input?.task_id ?? notFoundMatch[1] ?? "")
    if (taskId) {
      const recovered = await tryReadOutputFile(taskId, input.cwd ?? process.cwd())
      if (recovered) {
        const failureReason = detectFailure(recovered, null)
        if (failureReason) {
          denyPostToolUse(
            `Task \`${taskId}\` output (recovered from file — record had expired):\n\n${failureReason}`
          )
        }
        // No failure detected — inject recovered content as context.
        emitContext(
          "PostToolUse",
          `Task \`${taskId}\` output recovered from file (record had expired).\n` +
            `Output preview:\n${recovered.slice(0, 500)}`,
          input.cwd ?? process.cwd()
        )
      }
    }
    // Output file also unavailable — surface the garbage-collected task ID so the agent
    // receives actionable feedback rather than null/silent output.
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
