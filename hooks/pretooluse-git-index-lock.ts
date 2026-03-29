#!/usr/bin/env bun

// PreToolUse hook: Auto-resolve stale .git/index.lock files before blocking.
// When a lock exists but no relevant git process is active for this repo,
// the hook removes the stale lock and allows the command to proceed.
// Only blocks when a genuine git process is still running or cleanup fails.

import { unlink } from "node:fs/promises"
import { compact } from "lodash-es"
import { GIT_DIR_NAME, GIT_INDEX_LOCK, joinGitPath } from "../src/git-helpers.ts"
import {
  allowPreToolUse,
  denyPreToolUse,
  formatActionPlan,
  GIT_ANY_CMD_RE,
  git,
  isShellTool,
  spawnWithTimeout,
} from "../src/utils/hook-utils.ts"
import { type ToolHookInput, toolHookInputSchema } from "./schemas.ts"

// ── Constants ────────────────────────────────────────────────────────────────

const LOCK_RELATIVE_PATH = `${GIT_DIR_NAME}/${GIT_INDEX_LOCK}`
const WAIT_TIMEOUT_MS = 8000
const WAIT_INTERVAL_MS = 200
const LSOF_TIMEOUT_MS = 500
const MAX_ANCESTRY_DEPTH = 20
const REMOVE_MAX_RETRIES = 3
const REMOVE_RETRY_DELAY_MS = 150
const STALE_LOCK_AGE_MS = 10_000

// ── Main Execution ───────────────────────────────────────────────────────────

async function validateMainInputs(
  input: ToolHookInput
): Promise<{ cwd: string; repoRoot: string; lockPath: string } | null> {
  // Only applies to shell tools running git commands.
  if (!isShellTool(input.tool_name ?? "")) return null

  const command: string = (input.tool_input?.command as string) ?? ""
  if (!GIT_ANY_CMD_RE.test(command)) return null

  const cwd = input.cwd || process.cwd()

  // Find the repo root — handles subdirectories and worktrees.
  const repoRoot = await git(["rev-parse", "--show-toplevel"], cwd)
  if (!repoRoot) return null // Not in a git repo; let git itself report the error.

  const lockPath = joinGitPath(repoRoot, GIT_INDEX_LOCK)

  // Quick exit if no lock exists
  if (!(await Bun.file(lockPath).exists())) return null

  return { cwd, repoRoot, lockPath }
}

async function handleLockResolution(lockPath: string, repoRoot: string): Promise<void> {
  // Wait for lock to resolve or git process to finish
  const { lockExists, gitActive } = await waitForLockResolution(lockPath, repoRoot)

  if (!lockExists) {
    allowPreToolUse(`\`${LOCK_RELATIVE_PATH}\` resolved automatically — proceeding.`)
  }

  if (!gitActive) {
    await autoRemoveStaleLock(lockPath)
  }

  // Git process appears active, but the lock may be stale if it's old enough.
  // Attempt removal for aged locks — pgrep false-positives are common.
  const lockAge = await getLockAgeMs(lockPath)
  if (lockAge >= STALE_LOCK_AGE_MS) {
    await autoRemoveStaleLock(lockPath)
  }

  // A relevant git process IS active and lock is recent — block to prevent corruption.
  denyPreToolUse(
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

async function main() {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())

  const validated = await validateMainInputs(input)
  if (!validated) process.exit(0)

  await handleLockResolution(validated.lockPath, validated.repoRoot)
}

// ── High-Level Logic ─────────────────────────────────────────────────────────

async function waitForLockResolution(lockPath: string, repoRoot: string) {
  const start = Date.now()
  let gitActive = true
  let lockExists = true

  while (Date.now() - start < WAIT_TIMEOUT_MS) {
    lockExists = await Bun.file(lockPath).exists()
    if (!lockExists) break

    gitActive = await isGitProcessActiveForRepo(repoRoot)
    if (!gitActive) break

    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS))
  }

  return { lockExists, gitActive }
}

async function autoRemoveStaleLock(lockPath: string): Promise<void> {
  // Retry removal up to REMOVE_MAX_RETRIES times to handle transient failures.
  for (let attempt = 1; attempt <= REMOVE_MAX_RETRIES; attempt++) {
    try {
      // Lock may have already been removed by another process or a prior attempt.
      if (!(await Bun.file(lockPath).exists())) {
        allowPreToolUse(`\`${LOCK_RELATIVE_PATH}\` resolved (attempt ${attempt}) — proceeding.`)
      }

      await unlink(lockPath)

      // Verify removal succeeded (race condition: another process may have recreated it).
      if (!(await Bun.file(lockPath).exists())) {
        allowPreToolUse(
          `Auto-removed stale \`${LOCK_RELATIVE_PATH}\` on attempt ${attempt} — proceeding.`
        )
      }

      // Lock reappeared — retry if attempts remain.
    } catch {
      // ENOENT (lock vanished between exists() and unlink()) — that's fine.
      if (!(await Bun.file(lockPath).exists())) {
        allowPreToolUse(`\`${LOCK_RELATIVE_PATH}\` disappeared during cleanup — proceeding.`)
      }
      // Permission error or similar — retry if attempts remain.
    }

    if (attempt < REMOVE_MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, REMOVE_RETRY_DELAY_MS))
    }
  }

  // All retries exhausted — allow anyway and let git report the error if lock persists.
  allowPreToolUse(
    `\`${LOCK_RELATIVE_PATH}\` cleanup exhausted ${REMOVE_MAX_RETRIES} retries — proceeding (git will report if lock persists).`
  )
}

async function getLockAgeMs(lockPath: string): Promise<number> {
  try {
    const file = Bun.file(lockPath)
    const stat = await file.stat()
    return Date.now() - stat.mtimeMs
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
 *      (e.g., git push → pre-push hook → bun → this hook).
 *   2. Repo scope: exclude git processes whose CWD is outside our repo root.
 */
async function isGitProcessActiveForRepo(repoRoot: string): Promise<boolean> {
  const gitPids = await getRunningGitPids()
  if (gitPids.length === 0) return false

  const ancestors = await getAncestorPids()

  // Filter out ancestor PIDs and this process itself.
  const nonAncestorPids = gitPids.filter((pid) => pid !== process.pid && !ancestors.has(pid))
  if (nonAncestorPids.length === 0) return false

  // Check each remaining pid individually so one slow/unresponsive process
  // does not force a global timeout classification.
  for (const pid of nonAncestorPids) {
    if (await isPidUsingRepoDir(pid, repoRoot)) {
      return true
    }
  }

  return false
}

// ── Low-Level Utilities ──────────────────────────────────────────────────────

async function getRunningGitPids(): Promise<number[]> {
  const result = await spawnWithTimeout(["pgrep", "-f", "git"], { timeoutMs: 3_000 })
  if (result.timedOut || result.exitCode !== 0) return []
  return compact(result.stdout.trim().split("\n").map(Number))
}

async function buildParentMap(): Promise<Map<number, number>> {
  const result = await spawnWithTimeout(["ps", "-eo", "pid,ppid"], { timeoutMs: 3_000 })
  if (result.timedOut) return new Map<number, number>()
  const out = result.stdout

  const parentMap = new Map<number, number>()
  for (const line of out.trim().split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/)
    const pid = parseInt(parts[0] ?? "", 10)
    const ppid = parseInt(parts[1] ?? "", 10)
    if (!Number.isNaN(pid) && !Number.isNaN(ppid)) parentMap.set(pid, ppid)
  }

  return parentMap
}

function walkAncestry(parentMap: Map<number, number>): Set<number> {
  const ancestors = new Set<number>()
  let cur = process.ppid
  for (let i = 0; i < MAX_ANCESTRY_DEPTH && cur > 1; i++) {
    ancestors.add(cur)
    const ppid = parentMap.get(cur)
    if (!ppid || ppid === cur) break
    cur = ppid
  }
  return ancestors
}

async function getAncestorPids(): Promise<Set<number>> {
  const parentMap = await buildParentMap()
  return walkAncestry(parentMap)
}

async function isPidUsingRepoDir(pid: number, repoRoot: string): Promise<boolean> {
  try {
    const result = await spawnWithTimeout(["lsof", "-p", String(pid), "-d", "cwd", "-Fn"], {
      timeoutMs: LSOF_TIMEOUT_MS,
    })

    if (result.timedOut) return false

    return result.stdout
      .split("\n")
      .some((line) => line.startsWith("n") && line.slice(1).startsWith(repoRoot))
  } catch {
    // If lsof fails or is not in PATH, we cannot safely determine the process's working directory.
    // Assume it might be using this repo to prevent concurrent index modification.
    return true
  }
}

// ── Entry Point ──────────────────────────────────────────────────────────────

if (import.meta.main) {
  void main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    denyPreToolUse(
      `STOP. \u26a0\ufe0f pretooluse-git-index-lock encountered an unexpected error.\n\n` +
        `Error: ${message}\n\n` +
        formatActionPlan(
          [
            "Check that the hook file and its dependencies are intact.",
            "If the error persists, inspect the hook source at hooks/pretooluse-git-index-lock.ts.",
          ],
          { translateToolNames: true }
        )
    )
  })
}
