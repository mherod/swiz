#!/usr/bin/env bun
// Stop hook: Block stop if current branch has conflicts with origin/main
// Checks both GitHub PR merge state (authoritative) and local merge-tree (fallback)

import {
  blockStop,
  ghJson,
  git,
  hasGhCli,
  isDefaultBranch,
  isGitRepo,
  type StopHookInput,
  skillAdvice,
} from "./hook-utils.ts"

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput
  const cwd = input.cwd

  if (!(await isGitRepo(cwd))) return

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return // detached HEAD

  // Skip if on main or master
  if (isDefaultBranch(branch)) return

  // --- GitHub PR merge state check (authoritative) ---
  if (hasGhCli()) {
    const pr = await ghJson<{
      state: string
      mergeable: string
      mergeStateStatus: string
      number: number
      url: string
    }>(["pr", "view", branch, "--json", "mergeable,mergeStateStatus,state,number,url"], cwd)
    if (pr) {
      if (pr.state === "OPEN" && pr.mergeable === "CONFLICTING") {
        let reason = `PR #${pr.number} for branch '${branch}' has merge conflicts (GitHub: mergeable=CONFLICTING, mergeStateStatus=${pr.mergeStateStatus}).\n\n`
        reason += `${pr.url}\n\n`
        reason += skillAdvice(
          "rebase-onto-main",
          "Use the /rebase-onto-main skill to rebase and resolve conflicts before stopping.",
          "Rebase and resolve conflicts before stopping:\n  git fetch origin main\n  git rebase origin/main"
        )
        blockStop(reason)
      }

      // If GitHub says it's clean, trust it
      if (pr.state === "OPEN" && pr.mergeable === "MERGEABLE") return
    }
  }

  // --- Local merge-tree check (fallback for branches without PRs) ---
  const originMain = await git(["rev-parse", "origin/main"], cwd)
  if (!originMain) return

  const behindStr = await git(["rev-list", "--count", "HEAD..origin/main"], cwd)
  const behind = parseInt(behindStr, 10)
  if (Number.isNaN(behind) || behind === 0) return

  const mergeBase = await git(["merge-base", "HEAD", "origin/main"], cwd)
  if (!mergeBase) return

  const mergeTree = await git(["merge-tree", mergeBase, "HEAD", "origin/main"], cwd)
  const conflictCount = (mergeTree.match(/^<<<<<</gm) ?? []).length

  if (conflictCount > 0) {
    let reason = `Branch '${branch}' has conflicts with origin/main.\n\n`
    reason += `${conflictCount} conflict(s) detected — ${behind} commit(s) on origin/main not yet in this branch.\n\n`
    reason += skillAdvice(
      "rebase-onto-main",
      "Use the /rebase-onto-main skill to rebase and resolve conflicts before stopping.",
      "Rebase and resolve conflicts before stopping:\n  git fetch origin main\n  git rebase origin/main"
    )
    blockStop(reason)
  }
}

main()
