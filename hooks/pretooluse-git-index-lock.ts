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

  // A relevant git process IS active — never unlink, whatever the lock's age.
  // The old stale-age override deleted a live lock after 10s, but a routine
  // lefthook commit chain holds it for 30s+, and in a shared checkout the
  // holder may be a peer session's commit (issue #838).
  return preToolUseDeny(
    [
      `\`${LOCK_RELATIVE_PATH}\` exists and an active git process was detected for this repository.`,
      "",
      "The holder may be this session's own hook chain or a peer session's",
      "in-flight commit — a lefthook pre-commit run holds the lock for 30s+.",
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

/**
 * Ancestry-aware, repo-scoped process check.
 * Returns true if a git process is actively using this repo's index.
 *
 * Three-stage filter:
 *   1. Executable: only processes whose argv[0] basename is `git` (or a
 *      `git-*` helper) count — a substring match over command lines counted
 *      editors, wrappers, and anything mentioning "git" (issue #838).
 *   2. Ancestry: exclude git processes that are ancestors of this process
 *      (e.g., git push -> pre-push hook -> bun -> this hook).
 *   3. Repo scope: a candidate whose argv names this repo (git -C <repo> …)
 *      is active wherever its cwd points; otherwise fall back to the lsof
 *      cwd check. The old cwd-only probe was blind to -C invocations and
 *      unlinked their live locks.
 */
interface GitProcessRow {
  pid: number
  ppid: number
  command: string
}

function parseGitProcessLine(line: string): GitProcessRow | null {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
  if (!match) return null
  const pid = parseInt(match[1] ?? "", 10)
  const ppid = parseInt(match[2] ?? "", 10)
  if (Number.isNaN(pid) || Number.isNaN(ppid)) return null
  return { pid, ppid, command: match[3] ?? "" }
}

function isGitExecutable(command: string): boolean {
  const executable = command.split(/\s+/, 1)[0] ?? ""
  const base = executable.slice(executable.lastIndexOf("/") + 1)
  return base === "git" || base.startsWith("git-")
}

/**
 * Whether a command's argv names this repo as a path token. A bare
 * `includes(repoRoot)` false-positives on sibling paths that merely extend
 * ours (…/swiz matching inside …/swiz-other), so the character after the
 * match must terminate the path: end-of-string, a path separator, whitespace,
 * or a closing quote (verifier follow-up on d74ede0a).
 */
export function argvNamesRepo(command: string, repoRoot: string): boolean {
  let from = 0
  while (true) {
    const at = command.indexOf(repoRoot, from)
    if (at === -1) return false
    const next = command[at + repoRoot.length]
    if (next === undefined || next === "/" || next === "'" || next === '"' || /\s/.test(next)) {
      return true
    }
    from = at + 1
  }
}

function parseGitProcessTable(out: string): {
  rows: GitProcessRow[]
  parentMap: Map<number, number>
} {
  const rows: GitProcessRow[] = []
  const parentMap = new Map<number, number>()
  for (const line of out.trim().split("\n").slice(1)) {
    const row = parseGitProcessLine(line)
    if (!row) continue
    parentMap.set(row.pid, row.ppid)
    if (isGitExecutable(row.command)) rows.push(row)
  }
  return { rows, parentMap }
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

async function listCandidateGitProcesses(
  deadlineMs: number,
  runtime: ProcessInspectionRuntime
): Promise<GitProcessRow[] | null> {
  const timeoutMs = boundedTimeoutMs(deadlineMs, 3_000, runtime)
  if (timeoutMs === null) return null
  const result = await spawnForProcessInspection(
    runtime,
    ["ps", "-axo", "pid,ppid,command"],
    timeoutMs
  )
  if (result === null || result.timedOut || result.exitCode !== 0) return null

  const { rows, parentMap } = parseGitProcessTable(result.stdout)
  const ancestors = walkAncestry(parentMap, runtime.ppid())
  const currentPid = runtime.pid()
  return rows.filter((row) => row.pid !== currentPid && !ancestors.has(row.pid))
}

async function processesUseRepo(
  pids: number[],
  repoRoot: string,
  deadlineMs: number,
  runtime: ProcessInspectionRuntime
): Promise<boolean> {
  const timeoutMs = boundedTimeoutMs(deadlineMs, LSOF_TIMEOUT_MS, runtime)
  if (timeoutMs === null) return true
  const result = await spawnForProcessInspection(
    runtime,
    ["lsof", "-a", "-p", pids.join(","), "-d", "cwd", "-Fn"],
    timeoutMs
  )
  if (result === null || result.timedOut) return true
  if (lsofOutputUsesRepo(result.stdout, repoRoot)) return true
  if (result.stdout.trim().length > 0 || result.exitCode === 0) return false
  return result.stderr.trim().length > 0
}

/**
 * Inspect running Git processes without allowing subprocess work to exceed the
 * lock-release deadline. One ps pass supplies executables, argv, and the
 * parent map; candidate PIDs are then checked in one lsof invocation so
 * long-lived fsmonitor daemons cannot multiply the timeout.
 */
export async function inspectGitProcessesForRepo(
  repoRoot: string,
  deadlineMs: number,
  runtime: ProcessInspectionRuntime = defaultRuntime
): Promise<boolean> {
  const candidates = await listCandidateGitProcesses(deadlineMs, runtime)
  if (candidates === null) return true
  if (candidates.length === 0) return false

  // argv-aware repo association: `git -C <repo> …` runs with its cwd anywhere.
  if (candidates.some((row) => argvNamesRepo(row.command, repoRoot))) return true

  return await processesUseRepo(
    candidates.map((row) => row.pid),
    repoRoot,
    deadlineMs,
    runtime
  )
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
