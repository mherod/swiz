#!/usr/bin/env bun

// PreToolUse hook: Enforce a minimum visibility period before PR merges.
//
// Detects two merge vectors:
//   1. `gh pr merge` — the standard GitHub CLI merge command
//   2. `git merge <branch>` — raw git merge that could bypass the PR workflow
//
// For both, fetches the PR's createdAt timestamp. If the PR has been open for
// less than the configured grace period (10 minutes), the merge is blocked with
// a message directing the agent to work on other tasks.
//
// Rationale: gives team members time to review or raise concerns before a PR
// is merged, preventing premature merges that bypass team visibility.

import { readSwizSettings } from "../src/settings.ts"
import {
  denyPreToolUse,
  getDefaultBranch,
  getOpenPrForBranch,
  gh,
  git,
  isShellTool,
  type ToolHookInput,
} from "./hook-utils.ts"

/** Regex to match `gh pr merge` commands, accounting for pipes/chains. */
export const GH_PR_MERGE_RE = /(?:^|\|\||&&|;)\s*gh\s+pr\s+merge\b/

/** Regex to match `git merge <branch>` commands, accounting for pipes/chains. */
export const GIT_MERGE_RE = /(?:^|\|\||&&|;)\s*git\s+merge\b/

/** Extract the PR number from a `gh pr merge <number>` command. */
export function extractPrNumber(command: string): string | null {
  const match = command.match(/gh\s+pr\s+merge\s+(\d+)/)
  return match?.[1] ?? null
}

/** Extract the branch name from a `git merge <branch>` command. */
export function extractMergeBranch(command: string): string | null {
  // Match `git merge <branch>`, skipping flags (--no-ff, --squash, etc.)
  const match = command.match(/git\s+merge\s+(?:--\S+\s+)*([^\s;|&]+)/)
  if (!match?.[1]) return null
  const branch = match[1]
  // Filter out flags that look like branches
  if (branch.startsWith("-")) return null
  return branch
}

/** Format milliseconds as "Xm Ys". */
export function formatRemaining(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s`
  return `${minutes}m ${seconds}s`
}

function blockMerge(remaining: string, graceMinutes: number): never {
  denyPreToolUse(
    `BLOCKED: PR is in its visibility grace period (${remaining} remaining).\n\n` +
      `PRs must be open for at least ${graceMinutes} minutes before merging to give ` +
      `team members time to review or raise concerns.\n\n` +
      `Do not wait or retry — move on to your next task or issue. ` +
      `The merge will be allowed after the grace period expires.`
  )
}

async function checkPrAge(
  createdAtStr: string,
  gracePeriodMs: number,
  graceMinutes: number
): Promise<void> {
  const createdAt = new Date(createdAtStr).getTime()
  if (isNaN(createdAt)) return

  const elapsed = Date.now() - createdAt

  if (elapsed < gracePeriodMs) {
    const remaining = formatRemaining(gracePeriodMs - elapsed)
    blockMerge(remaining, graceMinutes)
  }
}

if (import.meta.main) {
  const input: ToolHookInput = await Bun.stdin.json()
  if (!isShellTool(input?.tool_name ?? "")) process.exit(0)

  const command: string = (input?.tool_input?.command as string) ?? ""

  const isGhPrMerge = GH_PR_MERGE_RE.test(command)
  const isGitMerge = GIT_MERGE_RE.test(command)

  // Only gate on merge commands
  if (!isGhPrMerge && !isGitMerge) process.exit(0)

  // Read configured grace period from settings (0 = disabled)
  const settings = await readSwizSettings()
  const graceMinutes = settings.prAgeGateMinutes
  if (graceMinutes <= 0) process.exit(0)
  const gracePeriodMs = graceMinutes * 60 * 1000

  const cwd: string = (input?.tool_input?.cwd as string) ?? process.cwd()

  if (isGhPrMerge) {
    // Vector 1: gh pr merge — fetch PR createdAt directly
    const prNumber = extractPrNumber(command)
    const createdAtStr = prNumber
      ? await gh(["pr", "view", prNumber, "--json", "createdAt", "--jq", ".createdAt"], cwd)
      : await gh(["pr", "view", "--json", "createdAt", "--jq", ".createdAt"], cwd)

    if (!createdAtStr) process.exit(0)
    await checkPrAge(createdAtStr, gracePeriodMs, graceMinutes)
  } else if (isGitMerge) {
    // Vector 2: git merge <branch> — look up the PR for the branch being merged
    const branch = extractMergeBranch(command)
    if (!branch) process.exit(0)

    // Strip remote prefix (origin/) to get the branch name for PR lookup
    const branchName = branch.replace(/^origin\//, "")

    // Skip merging default branch into feature branches (that's pulling upstream, not merging a PR)
    const currentBranch = await git(["branch", "--show-current"], cwd)
    const defaultBranch = await getDefaultBranch(cwd)
    if (branchName === defaultBranch) process.exit(0)
    // Also skip if merging the current branch into itself (no-op)
    if (branchName === currentBranch) process.exit(0)

    const pr = await getOpenPrForBranch<{ createdAt: string }>(branchName, cwd, "createdAt")
    if (!pr?.createdAt) process.exit(0)
    await checkPrAge(pr.createdAt, gracePeriodMs, graceMinutes)
  }
}
