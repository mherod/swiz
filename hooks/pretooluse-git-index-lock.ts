#!/usr/bin/env bun

// PreToolUse hook: Auto-resolve stale .git/index.lock files before blocking.
// When a lock exists but no relevant git process is active for this repo,
// the hook removes the stale lock and allows the command to proceed.
// Only blocks when a genuine git process is still running or cleanup fails.

import { unlink } from "node:fs/promises"
import { GIT_DIR_NAME, GIT_INDEX_LOCK, joinGitPath } from "../src/git-helpers.ts"
import {
  allowPreToolUse,
  denyPreToolUse,
  formatActionPlan,
  GIT_ANY_CMD_RE,
  git,
  isShellTool,
  type ToolHookInput,
} from "./hook-utils.ts"

const input: ToolHookInput = await Bun.stdin.json()

// Only applies to shell tools running git commands.
if (!isShellTool(input.tool_name ?? "")) process.exit(0)

const command: string = (input.tool_input?.command as string) ?? ""
if (!GIT_ANY_CMD_RE.test(command)) process.exit(0)

const cwd = input.cwd || process.cwd()
const LOCK_RELATIVE_PATH = `${GIT_DIR_NAME}/${GIT_INDEX_LOCK}`

// Find the repo root — handles subdirectories and worktrees.
const repoRoot = await git(["rev-parse", "--show-toplevel"], cwd)
if (!repoRoot) process.exit(0) // Not in a git repo; let git itself report the error.

const lockPath = joinGitPath(repoRoot, GIT_INDEX_LOCK)
if (!(await Bun.file(lockPath).exists())) process.exit(0)

// ── Lock exists — check if a relevant git process is still active ────────

/**
 * Ancestry-aware, repo-scoped process check.
 * Returns true if a git process is actively using this repo's index.
 *
 * Two-stage filter (consistent with stop-git-status.ts):
 *   1. Ancestry: exclude git processes that are ancestors of this process
 *      (e.g., git push → pre-push hook → bun → this hook).
 *   2. Repo scope: exclude git processes whose CWD is outside our repo root.
 */
async function isGitProcessActiveForRepo(): Promise<boolean> {
  // Find all git processes.
  const pgrepProc = Bun.spawn(["pgrep", "-f", "git"], { stdout: "pipe", stderr: "pipe" })
  const pgrepOut = await new Response(pgrepProc.stdout).text()
  await pgrepProc.exited
  if (pgrepProc.exitCode !== 0) return false // No git processes at all.

  const gitPids = pgrepOut.trim().split("\n").map(Number).filter(Boolean)
  if (gitPids.length === 0) return false

  // Build ancestry set: walk from this process upward to PID 1.
  const psProc = Bun.spawn(["ps", "-eo", "pid,ppid"], { stdout: "pipe", stderr: "pipe" })
  const psOut = await new Response(psProc.stdout).text()
  await psProc.exited

  const parentMap = new Map<number, number>()
  for (const line of psOut.trim().split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/)
    const pid = parseInt(parts[0] ?? "", 10)
    const ppid = parseInt(parts[1] ?? "", 10)
    if (!Number.isNaN(pid) && !Number.isNaN(ppid)) parentMap.set(pid, ppid)
  }

  const ancestors = new Set<number>()
  let cur = process.ppid
  for (let i = 0; i < 20 && cur > 1; i++) {
    ancestors.add(cur)
    const ppid = parentMap.get(cur)
    if (!ppid || ppid === cur) break
    cur = ppid
  }

  // Filter out ancestor PIDs and this process itself.
  const nonAncestorPids = gitPids.filter((pid) => pid !== process.pid && !ancestors.has(pid))
  if (nonAncestorPids.length === 0) return false

  // Check each remaining pid individually so one slow/unresponsive process
  // does not force a global timeout classification.
  for (const pid of nonAncestorPids) {
    const lsofProc = Bun.spawn(["lsof", "-p", String(pid), "-d", "cwd", "-Fn"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    let lsofKilled = false
    const killTimer = setTimeout(() => {
      lsofKilled = true
      lsofProc.kill()
    }, 500)
    const lsofOut = await new Response(lsofProc.stdout).text()
    await lsofProc.exited
    clearTimeout(killTimer)

    if (lsofKilled) continue

    for (const line of lsofOut.split("\n")) {
      if (line.startsWith("n") && line.slice(1).startsWith(repoRoot)) {
        return true
      }
    }
  }
  return false
}

// ── Decision ─────────────────────────────────────────────────────────────────

const gitActive = await isGitProcessActiveForRepo()

if (!gitActive) {
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
