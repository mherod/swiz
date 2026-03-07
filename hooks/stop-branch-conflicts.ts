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

async function main(): Promise<void> {
  const input = stopHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return // detached HEAD

  const defaultBranch = await getDefaultBranch(cwd)

  // Skip when currently on the default branch
  if (isDefaultBranch(branch, defaultBranch)) return

  const defaultRemoteRef = `origin/${defaultBranch}`

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
          "Use the /rebase-onto-main skill to rebase and resolve conflicts before stopping.\n" +
            "Tip: Configure `swiz mergetool` as your Git mergetool for AI-powered conflict resolution:\n" +
            '  git config merge.tool swiz && git config mergetool.swiz.cmd \'swiz mergetool "$BASE" "$LOCAL" "$REMOTE" "$MERGED"\' && git config mergetool.swiz.trustExitCode true',
          `Rebase and resolve conflicts before stopping:\n  git fetch origin ${defaultBranch}\n  git rebase ${defaultRemoteRef}\n` +
            "Tip: Use `swiz mergetool` for AI-powered conflict resolution:\n" +
            '  git config merge.tool swiz && git config mergetool.swiz.cmd \'swiz mergetool "$BASE" "$LOCAL" "$REMOTE" "$MERGED"\' && git config mergetool.swiz.trustExitCode true'
        )
        blockStop(reason)
      }

      // If GitHub says it's clean, trust it
      if (pr.state === "OPEN" && pr.mergeable === "MERGEABLE") return
    }
  }

  // --- Local merge-tree check (fallback for branches without PRs) ---
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
    let reason = `Branch '${branch}' has conflicts with ${defaultRemoteRef}.\n\n`
    reason += `${conflictCount} conflict(s) detected — ${behind} commit(s) on ${defaultRemoteRef} not yet in this branch.\n\n`
    reason += skillAdvice(
      "rebase-onto-main",
      "Use the /rebase-onto-main skill to rebase and resolve conflicts before stopping.\n" +
        "Tip: Configure `swiz mergetool` as your Git mergetool for AI-powered conflict resolution:\n" +
        '  git config merge.tool swiz && git config mergetool.swiz.cmd \'swiz mergetool "$BASE" "$LOCAL" "$REMOTE" "$MERGED"\' && git config mergetool.swiz.trustExitCode true',
      `Rebase and resolve conflicts before stopping:\n  git fetch origin ${defaultBranch}\n  git rebase ${defaultRemoteRef}\n` +
        "Tip: Use `swiz mergetool` for AI-powered conflict resolution:\n" +
        '  git config merge.tool swiz && git config mergetool.swiz.cmd \'swiz mergetool "$BASE" "$LOCAL" "$REMOTE" "$MERGED"\' && git config mergetool.swiz.trustExitCode true'
    )
    blockStop(reason)
  }
}

main()
