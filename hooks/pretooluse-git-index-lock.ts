#!/usr/bin/env bun

// PreToolUse hook: Auto-resolve stale .git/index.lock files before blocking.
// When a lock exists but no relevant git process is active for this repo,
// the hook removes the stale lock and allows the command to proceed.
// Only blocks when a genuine git process is still running or cleanup fails.
//
// Dual-mode: exports a SwizShellHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { unlink } from "node:fs/promises"
import { join } from "node:path"
import { compact } from "lodash-es"
import { GIT_DIR_NAME, GIT_INDEX_LOCK, git } from "../src/git-helpers.ts"
import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHookOutput,
  type SwizShellHook,
} from "../src/SwizHook.ts"
import { type ShellHookInput, shellHookInputSchema } from "../src/schemas.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { GIT_ANY_CMD_RE } from "../src/utils/git-utils.ts"
import { messageFromUnknownError } from "../src/utils/hook-json-helpers.ts"
import { formatActionPlan } from "../src/utils/inline-hook-helpers.ts"
import { type SpawnWithTimeoutResult, spawnWithTimeout } from "../src/utils/process-utils.ts"

// ── Constants ────────────────────────────────────────────────────────────────

const LOCK_RELATIVE_PATH = `${GIT_DIR_NAME}/${GIT_INDEX_LOCK}`
const WAIT_INTERVAL_MS = 200
const LOCK_RELEASE_TIMEOUT_MS = 10_000
const LSOF_TIMEOUT_MS = 500
const MAX_ANCESTRY_DEPTH = 20
const REMOVE_RETRY_DELAY_MS = 200
const STALE_LOCK_AGE_MS = 10_000

export interface GitIndexLockEvaluationOptions {
  lockReleaseTimeoutMs?: number
  waitIntervalMs?: number
  removeRetryDelayMs?: number
  runtime?: Partial<GitIndexLockRuntime>
}

/** External operations injected into the evaluator for deterministic tests. */
export interface GitIndexLockRuntime {
  git(args: string[], cwd: string): Promise<string>
  fileExists(path: string): Promise<boolean>
  unlink(path: string): Promise<void>
  fileMtimeMs(path: string): Promise<number>
  spawn(
    cmd: string[],
    options: { cwd?: string; timeoutMs?: number; stdin?: string }
  ): Promise<SpawnWithTimeoutResult>
  sleep(ms: number): Promise<void>
  now(): number
  pid(): number
  ppid(): number
}

const defaultRuntime: GitIndexLockRuntime = {
  git,
  fileExists: async (path) => await Bun.file(path).exists(),
  unlink,
  fileMtimeMs: async (path) => (await Bun.file(path).stat()).mtimeMs,
  spawn: spawnWithTimeout,
  sleep: async (ms) => {
    if (ms <= 0) return
    await new Promise((resolve) => setTimeout(resolve, ms))
  },
  now: Date.now,
  pid: () => process.pid,
  ppid: () => process.ppid,
}

function resolveRuntime(overrides: Partial<GitIndexLockRuntime> = {}): GitIndexLockRuntime {
  return { ...defaultRuntime, ...overrides }
}

// ── Validation & resolution ─────────────────────────────────────────────────

async function validateMainInputs(
  input: ShellHookInput,
  runtime: GitIndexLockRuntime
): Promise<{ repoRoot: string; lockPath: string } | null> {
  // Only applies to shell tools running git commands.
  if (!isShellTool(input.tool_name ?? "")) return null

  const command: string = (input.tool_input?.command as string) ?? ""
  if (!GIT_ANY_CMD_RE.test(command)) return null

  const cwd = input.cwd || process.cwd()

  // Find the repo root — handles subdirectories and worktrees.
  const repoRoot = await runtime.git(["rev-parse", "--show-toplevel"], cwd)
  if (!repoRoot) return null // Not in a git repo; let git itself report the error.

  const gitDir = await runtime.git(["rev-parse", "--absolute-git-dir"], cwd)
  if (!gitDir) return null
  const lockPath = join(gitDir, GIT_INDEX_LOCK)

  // Quick exit if no lock exists
  if (!(await runtime.fileExists(lockPath))) return null

  return { repoRoot, lockPath }
}

async function handleLockResolution(
  lockPath: string,
  repoRoot: string,
  options: GitIndexLockEvaluationOptions,
  runtime: GitIndexLockRuntime
): Promise<SwizHookOutput> {
  const lockReleaseTimeoutMs = options.lockReleaseTimeoutMs ?? LOCK_RELEASE_TIMEOUT_MS
  const waitIntervalMs = options.waitIntervalMs ?? WAIT_INTERVAL_MS
  const removeRetryDelayMs = options.removeRetryDelayMs ?? REMOVE_RETRY_DELAY_MS
  const releaseDeadlineMs = runtime.now() + lockReleaseTimeoutMs

  // Wait for lock to resolve or git process to finish
  const { lockExists, gitActive } = await waitForLockResolution(
    lockPath,
    repoRoot,
    releaseDeadlineMs,
    waitIntervalMs,
    runtime
  )

  if (!lockExists) {
    return preToolUseAllow(`\`${LOCK_RELATIVE_PATH}\` resolved automatically — proceeding.`)
  }

  if (!gitActive) {
    return await autoRemoveStaleLock(
      lockPath,
      releaseDeadlineMs,
      removeRetryDelayMs,
      lockReleaseTimeoutMs,
      runtime
    )
  }

  // Git process appears active, but the lock may be stale if it's old enough.
  // Attempt removal for aged locks — pgrep false-positives are common.
  const lockAge = await getLockAgeMs(lockPath, runtime)
  if (lockAge >= STALE_LOCK_AGE_MS) {
    return await autoRemoveStaleLock(
      lockPath,
      releaseDeadlineMs,
      removeRetryDelayMs,
      lockReleaseTimeoutMs,
      runtime
    )
  }

  // A relevant git process IS active and lock is recent — block to prevent corruption.
  return preToolUseDeny(
    [
      `\`${LOCK_RELATIVE_PATH}\` exists and an active git process was detected for this repository.`,
      "",
      "This lock will cause your git command to fail with:",
      `  "fatal: Unable to create '.../${LOCK_RELATIVE_PATH}': File exists."`,
      "",
      formatActionPlan(
        [
          "Wait for the active git process to finish, then retry.",
          `If the process is stuck, check with: \`ps aux | grep git\` (task-exempt — runs without tasks)`,
          `Then remove the lock: \`trash ${lockPath}\` (task-exempt — runs without tasks)`,
        ],
        { header: "To resolve:" }
      ).trimEnd(),
    ].join("\n")
  )
}

async function autoRemoveStaleLock(
  lockPath: string,
  releaseDeadlineMs: number,
  removeRetryDelayMs: number,
  lockReleaseTimeoutMs: number,
  runtime: GitIndexLockRuntime
): Promise<SwizHookOutput> {
  let attempt = 0

  // Retry until the shared release deadline to handle transient permissions,
  // racing cleanup, and short-lived lock recreation.
  while (attempt === 0 || runtime.now() < releaseDeadlineMs) {
    attempt++
    try {
      // Lock may have already been removed by another process or a prior attempt.
      if (!(await runtime.fileExists(lockPath))) {
        return preToolUseAllow(
          `\`${LOCK_RELATIVE_PATH}\` resolved (attempt ${attempt}) — proceeding.`
        )
      }

      await runtime.unlink(lockPath)

      // Verify removal succeeded (race condition: another process may have recreated it).
      if (!(await runtime.fileExists(lockPath))) {
        return preToolUseAllow(
          `Auto-removed stale \`${LOCK_RELATIVE_PATH}\` on attempt ${attempt} — proceeding.`
        )
      }

      // Lock reappeared — retry if attempts remain.
    } catch {
      // ENOENT (lock vanished between exists() and unlink()) — that's fine.
      if (!(await runtime.fileExists(lockPath))) {
        return preToolUseAllow(`\`${LOCK_RELATIVE_PATH}\` disappeared during cleanup — proceeding.`)
      }
      // Permission error or similar — retry if attempts remain.
    }

    const remainingMs = releaseDeadlineMs - runtime.now()
    if (remainingMs <= 0) break
    await runtime.sleep(Math.min(removeRetryDelayMs, remainingMs))
  }

  // All retries exhausted — do NOT let the git command through if the lock still exists.
  if (!(await runtime.fileExists(lockPath))) {
    return preToolUseAllow(`Auto-removed stale \`${LOCK_RELATIVE_PATH}\` — proceeding.`)
  }

  return preToolUseDeny(
    [
      `\`${LOCK_RELATIVE_PATH}\` still present after retrying for up to ${lockReleaseTimeoutMs / 1000}s.`,
      "",
      "This lock will cause your git command to fail with:",
      `  "fatal: Unable to create '.../${LOCK_RELATIVE_PATH}': File exists."`,
      "",
      formatActionPlan(
        [
          `Check for stuck git processes: ps aux | grep git`,
          `Remove the lock manually: trash ${lockPath}`,
          "Then retry the command.",
        ],
        { header: "To resolve:" }
      ).trimEnd(),
    ].join("\n")
  )
}

async function waitForLockResolution(
  lockPath: string,
  repoRoot: string,
  releaseDeadlineMs: number,
  waitIntervalMs: number,
  runtime: GitIndexLockRuntime
) {
  let gitActive = true
  let lockExists = true

  while (runtime.now() < releaseDeadlineMs) {
    lockExists = await runtime.fileExists(lockPath)
    if (!lockExists) break

    gitActive = await inspectGitProcessesForRepo(repoRoot, releaseDeadlineMs, runtime)
    if (!gitActive) break

    await runtime.sleep(Math.min(waitIntervalMs, releaseDeadlineMs - runtime.now()))
  }

  return { lockExists, gitActive }
}

async function getLockAgeMs(lockPath: string, runtime: GitIndexLockRuntime): Promise<number> {
  try {
    return runtime.now() - (await runtime.fileMtimeMs(lockPath))
  } catch {
    return 0
  }
}

/**
 * Ancestry-aware, repo-scoped process check.
 * Returns true if a git process is actively using this repo's index.
 *
 * Two-stage filter (consistent with stop-git-status.ts):
 *   1. Ancestry: exclude git processes that are ancestors of this process
 *      (e.g., git push -> pre-push hook -> bun -> this hook).
 *   2. Repo scope: exclude git processes whose CWD is outside our repo root.
 */
function parseParentMap(out: string): Map<number, number> {
  const parentMap = new Map<number, number>()
  for (const line of out.trim().split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/)
    const pid = parseInt(parts[0] ?? "", 10)
    const ppid = parseInt(parts[1] ?? "", 10)
    if (!Number.isNaN(pid) && !Number.isNaN(ppid)) parentMap.set(pid, ppid)
  }

  return parentMap
}

function walkAncestry(parentMap: Map<number, number>, startPpid: number): Set<number> {
  const ancestors = new Set<number>()
  let cur = startPpid
  for (let i = 0; i < MAX_ANCESTRY_DEPTH && cur > 1; i++) {
    ancestors.add(cur)
    const ppid = parentMap.get(cur)
    if (!ppid || ppid === cur) break
    cur = ppid
  }
  return ancestors
}

function boundedTimeoutMs(
  deadlineMs: number,
  maximumMs: number,
  runtime: Pick<GitIndexLockRuntime, "now">
): number | null {
  const remainingMs = deadlineMs - runtime.now()
  if (remainingMs <= 0) return null
  return Math.max(1, Math.min(maximumMs, remainingMs))
}

function lsofOutputUsesRepo(stdout: string, repoRoot: string): boolean {
  const repoPrefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`
  return stdout.split("\n").some((line) => {
    if (!line.startsWith("n")) return false
    const path = line.slice(1)
    return path === repoRoot || path.startsWith(repoPrefix)
  })
}

type ProcessInspectionRuntime = Pick<GitIndexLockRuntime, "now" | "pid" | "ppid" | "spawn">

async function spawnForProcessInspection(
  runtime: ProcessInspectionRuntime,
  cmd: string[],
  timeoutMs: number
): Promise<SpawnWithTimeoutResult | null> {
  try {
    return await runtime.spawn(cmd, { timeoutMs })
  } catch {
    return null
  }
}

/**
 * Inspect running Git processes without allowing subprocess work to exceed the
 * lock-release deadline. Candidate PIDs are checked in one lsof invocation so
 * long-lived fsmonitor daemons cannot multiply the timeout.
 */
export async function inspectGitProcessesForRepo(
  repoRoot: string,
  deadlineMs: number,
  runtime: ProcessInspectionRuntime = defaultRuntime
): Promise<boolean> {
  const pgrepTimeoutMs = boundedTimeoutMs(deadlineMs, 3_000, runtime)
  if (pgrepTimeoutMs === null) return true
  const pgrepResult = await spawnForProcessInspection(
    runtime,
    ["pgrep", "-f", "git"],
    pgrepTimeoutMs
  )
  if (pgrepResult === null) return true
  if (pgrepResult.timedOut) return true
  if (pgrepResult.exitCode !== 0) return false

  const gitPids = compact(
    pgrepResult.stdout
      .trim()
      .split("\n")
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  )
  if (gitPids.length === 0) return false

  const psTimeoutMs = boundedTimeoutMs(deadlineMs, 3_000, runtime)
  if (psTimeoutMs === null) return true
  const psResult = await spawnForProcessInspection(runtime, ["ps", "-eo", "pid,ppid"], psTimeoutMs)
  if (psResult === null) return true
  if (psResult.timedOut || psResult.exitCode !== 0) return true

  const ancestors = walkAncestry(parseParentMap(psResult.stdout), runtime.ppid())
  const currentPid = runtime.pid()
  const nonAncestorPids = gitPids.filter((pid) => pid !== currentPid && !ancestors.has(pid))
  if (nonAncestorPids.length === 0) return false

  const lsofTimeoutMs = boundedTimeoutMs(deadlineMs, LSOF_TIMEOUT_MS, runtime)
  if (lsofTimeoutMs === null) return true
  const lsofResult = await spawnForProcessInspection(
    runtime,
    ["lsof", "-a", "-p", nonAncestorPids.join(","), "-d", "cwd", "-Fn"],
    lsofTimeoutMs
  )
  if (lsofResult === null || lsofResult.timedOut) return true
  if (lsofOutputUsesRepo(lsofResult.stdout, repoRoot)) return true
  if (lsofResult.stdout.trim().length > 0 || lsofResult.exitCode === 0) return false
  return lsofResult.stderr.trim().length > 0
}

export async function evaluatePretooluseGitIndexLock(
  input: unknown,
  options: GitIndexLockEvaluationOptions = {}
): Promise<SwizHookOutput> {
  try {
    const runtime = resolveRuntime(options.runtime)
    const parsed = shellHookInputSchema.parse(input)
    const validated = await validateMainInputs(parsed, runtime)
    if (!validated) return {}
    return await handleLockResolution(validated.lockPath, validated.repoRoot, options, runtime)
  } catch (err: unknown) {
    const message = messageFromUnknownError(err)
    return preToolUseDeny(
      `STOP. \u26a0\ufe0f pretooluse-git-index-lock encountered an unexpected error.\n\n` +
        `Error: ${message}\n\n` +
        formatActionPlan(
          [
            "Check that the hook file and its dependencies are intact.",
            "If the error persists, inspect the hook source at hooks/pretooluse-git-index-lock.ts.",
          ],
          { header: "To resolve:" }
        )
    )
  }
}

const pretooluseGitIndexLock: SwizShellHook = {
  name: "pretooluse-git-index-lock",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 12,

  run(input) {
    return evaluatePretooluseGitIndexLock(input)
  },
}

export default pretooluseGitIndexLock

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseGitIndexLock)
}
