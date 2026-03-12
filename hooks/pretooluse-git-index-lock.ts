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
} from "./hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

// ── Constants ────────────────────────────────────────────────────────────────

const LOCK_RELATIVE_PATH = `${GIT_DIR_NAME}/${GIT_INDEX_LOCK}`
const WAIT_TIMEOUT_MS = 5000
const WAIT_INTERVAL_MS = 500
const LSOF_TIMEOUT_MS = 500
const MAX_ANCESTRY_DEPTH = 20

// ── Main Execution ───────────────────────────────────────────────────────────

async function main() {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())

  // Only applies to shell tools running git commands.
  if (!isShellTool(input.tool_name ?? "")) process.exit(0)

  const command: string = (input.tool_input?.command as string) ?? ""
  if (!GIT_ANY_CMD_RE.test(command)) process.exit(0)

  const cwd = input.cwd || process.cwd()

  // Find the repo root — handles subdirectories and worktrees.
  const repoRoot = await git(["rev-parse", "--show-toplevel"], cwd)
  if (!repoRoot) process.exit(0) // Not in a git repo; let git itself report the error.

  const lockPath = joinGitPath(repoRoot, GIT_INDEX_LOCK)

  // Quick exit if no lock exists
  if (!(await Bun.file(lockPath).exists())) process.exit(0)

  // Wait for lock to resolve or git process to finish
  const { lockExists, gitActive } = await waitForLockResolution(lockPath, repoRoot)

  if (!lockExists) {
    allowPreToolUse(`\`${LOCK_RELATIVE_PATH}\` resolved automatically — proceeding.`)
  }

  if (!gitActive) {
    await autoRemoveStaleLock(lockPath)
  }

  // A relevant git process IS active — block to prevent corruption.
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
          `If the process is stuck, check with: \`ps aux | grep git\``,
          `Then remove the lock: \`trash ${lockPath}\``,
        ],
        { header: "To resolve:" }
      ).trimEnd(),
    ].join("\n")
  )
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
  // No relevant git process — stale lock. Try to remove it.
  try {
    await unlink(lockPath)

    // Verify removal succeeded (race condition: another process may have recreated it).
    if (await Bun.file(lockPath).exists()) {
      denyPreToolUse(
        [
          `\`${LOCK_RELATIVE_PATH}\` reappeared after removal — a concurrent git process may be active.`,
          "",
          formatActionPlan(
            [
              "Wait a moment and retry your git command.",
              `If the problem persists, manually check: \`ps aux | grep git\``,
            ],
            { header: "To resolve:" }
          ).trimEnd(),
        ].join("\n")
      )
    }

    allowPreToolUse(
      `Auto-removed stale \`${LOCK_RELATIVE_PATH}\` — no active git process detected.`
    )
  } catch {
    // Cleanup failed — maybe the lock disappeared between check and unlink (ENOENT),
    // or we lack permissions. Either way, allow the command to proceed — if the lock
    // is truly gone, git will succeed; if it still exists, git will report the error.
    allowPreToolUse(
      `\`${LOCK_RELATIVE_PATH}\` cleanup encountered an error but may have resolved — proceeding.`
    )
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
  const proc = Bun.spawn(["pgrep", "-f", "git"], { stdout: "pipe", stderr: "pipe" })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  if (proc.exitCode !== 0) return []
  return compact(out.trim().split("\n").map(Number))
}

async function getAncestorPids(): Promise<Set<number>> {
  const proc = Bun.spawn(["ps", "-eo", "pid,ppid"], { stdout: "pipe", stderr: "pipe" })
  const out = await new Response(proc.stdout).text()
  await proc.exited

  const parentMap = new Map<number, number>()
  for (const line of out.trim().split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/)
    const pid = parseInt(parts[0] ?? "", 10)
    const ppid = parseInt(parts[1] ?? "", 10)
    if (!Number.isNaN(pid) && !Number.isNaN(ppid)) parentMap.set(pid, ppid)
  }

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

async function isPidUsingRepoDir(pid: number, repoRoot: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["lsof", "-p", String(pid), "-d", "cwd", "-Fn"], {
      stdout: "pipe",
      stderr: "pipe",
    })

    let killed = false
    const timer = setTimeout(() => {
      killed = true
      proc.kill()
    }, LSOF_TIMEOUT_MS)

    const out = await new Response(proc.stdout).text()
    await proc.exited
    clearTimeout(timer)

    if (killed) return false

    return out
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
