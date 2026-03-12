#!/usr/bin/env bun
// Stop hook: Block stop if current branch has conflicts with the default branch.
// Checks both GitHub PR merge state (authoritative) and local merge-tree (fallback)

import {
  blockStop,
  getDefaultBranch,
  ghJson,
  git,
  hasGhCli,
  isDefaultBranch,
  isGitRepo,
  skillAdvice,
} from "./hook-utils.ts"
import { stopHookInputSchema } from "./schemas.ts"

function buildConflictReason(
  header: string,
  defaultBranch: string,
  defaultRemoteRef: string
): string {
  const rebaseSteps = [
    `Rebase and resolve conflicts before stopping:`,
    `  git fetch origin ${defaultBranch}`,
    `  git rebase ${defaultRemoteRef}`,
    "  # resolve any conflicts, then: git rebase --continue",
    "",
    "Tip: Use `swiz mergetool` for AI-powered conflict resolution:",
    '  git config merge.tool swiz && git config mergetool.swiz.cmd \'swiz mergetool "$BASE" "$LOCAL" "$REMOTE" "$MERGED"\' && git config mergetool.swiz.trustExitCode true',
  ].join("\n")
  return (
    header +
    skillAdvice(
      "rebase-onto-main",
      "Use the /rebase-onto-main skill to rebase and resolve conflicts before stopping.",
      rebaseSteps
    )
  )
}

async function checkPrConflicts(
  branch: string,
  cwd: string,
  defaultBranch: string,
  defaultRemoteRef: string
): Promise<boolean> {
  if (!hasGhCli()) return false
  const pr = await ghJson<{
    state: string
    mergeable: string
    mergeStateStatus: string
    number: number
    url: string
  }>(["pr", "view", branch, "--json", "mergeable,mergeStateStatus,state,number,url"], cwd)
  if (!pr) return false
  if (pr.state === "OPEN" && pr.mergeable === "CONFLICTING") {
    const header = `PR #${pr.number} for branch '${branch}' has merge conflicts (GitHub: mergeable=CONFLICTING, mergeStateStatus=${pr.mergeStateStatus}).\n\n${pr.url}\n\n`
    blockStop(buildConflictReason(header, defaultBranch, defaultRemoteRef))
  }
  return pr.state === "OPEN" && pr.mergeable === "MERGEABLE"
}

async function checkLocalConflicts(
  branch: string,
  cwd: string,
  defaultBranch: string,
  defaultRemoteRef: string
): Promise<void> {
  const originDefault = await git(["rev-parse", defaultRemoteRef], cwd)
  if (!originDefault) return

  const behindStr = await git(["rev-list", "--count", `HEAD..${defaultRemoteRef}`], cwd)
  const behind = parseInt(behindStr, 10)
  if (Number.isNaN(behind) || behind === 0) return

  const mergeBase = await git(["merge-base", "HEAD", defaultRemoteRef], cwd)
  if (!mergeBase) return

  const mergeTree = await git(["merge-tree", mergeBase, "HEAD", defaultRemoteRef], cwd)
  const conflictCount = (mergeTree.match(/^<<<<<</gm) ?? []).length

  if (conflictCount > 0) {
    const header = `Branch '${branch}' has conflicts with ${defaultRemoteRef}.\n\n${conflictCount} conflict(s) detected — ${behind} commit(s) on ${defaultRemoteRef} not yet in this branch.\n\n`
    blockStop(buildConflictReason(header, defaultBranch, defaultRemoteRef))
  }
}

async function main(): Promise<void> {
  const input = stopHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return

  const defaultBranch = await getDefaultBranch(cwd)
  if (isDefaultBranch(branch, defaultBranch)) return

  const defaultRemoteRef = `origin/${defaultBranch}`
  if (await checkPrConflicts(branch, cwd, defaultBranch, defaultRemoteRef)) return
  await checkLocalConflicts(branch, cwd, defaultBranch, defaultRemoteRef)
}

if (import.meta.main) void main()
