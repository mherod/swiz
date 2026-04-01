#!/usr/bin/env bun

// Stop hook: Block stop if current branch has conflicts with the default branch.
// Checks both GitHub PR merge state (authoritative) and local merge-tree (fallback)
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import {
  blockStopObj,
  detectForkTopology,
  forkRemoteRef,
  getDefaultBranch,
  ghJson,
  git,
  hasGhCli,
  isDefaultBranch,
  isGitRepo,
  skillAdvice,
} from "../src/utils/hook-utils.ts"
import { type StopHookInput, stopHookInputSchema } from "./schemas.ts"

function buildConflictReason(
  header: string,
  defaultBranch: string,
  defaultRemoteRef: string
): string {
  const fetchRemote = defaultRemoteRef.startsWith("upstream/") ? "upstream" : "origin"
  const rebaseSteps = [
    `Rebase and resolve conflicts before stopping:`,
    `  git fetch ${fetchRemote} ${defaultBranch}`,
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

const STALE_BRANCH_THRESHOLD = 50

export async function evaluateStopBranchConflicts(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  const cwd = parsed.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return {}

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return {}

  const defaultBranch = await getDefaultBranch(cwd)
  if (isDefaultBranch(branch, defaultBranch)) return {}

  const fork = await detectForkTopology(cwd)
  const defaultRemoteRef = forkRemoteRef(defaultBranch, fork)

  if (hasGhCli()) {
    const pr = await ghJson<{
      state: string
      mergeable: string
      mergeStateStatus: string
      number: number
      url: string
    }>(["pr", "view", branch, "--json", "mergeable,mergeStateStatus,state,number,url"], cwd)
    if (pr?.state === "OPEN" && pr.mergeable === "CONFLICTING") {
      const header = `PR #${pr.number} for branch '${branch}' has merge conflicts (GitHub: mergeable=CONFLICTING, mergeStateStatus=${pr.mergeStateStatus}).\n\n${pr.url}\n\n`
      return blockStopObj(buildConflictReason(header, defaultBranch, defaultRemoteRef))
    }
    if (pr?.state === "OPEN" && pr.mergeable === "MERGEABLE") return {}
  }

  const originDefault = await git(["rev-parse", defaultRemoteRef], cwd)
  if (!originDefault) return {}

  const behindStr = await git(["rev-list", "--count", `HEAD..${defaultRemoteRef}`], cwd)
  const behind = parseInt(behindStr, 10)
  if (Number.isNaN(behind) || behind === 0) return {}

  const mergeBase = await git(["merge-base", "HEAD", defaultRemoteRef], cwd)
  if (!mergeBase) return {}

  const mergeTree = await git(["merge-tree", mergeBase, "HEAD", defaultRemoteRef], cwd)
  const conflictCount = (mergeTree.match(/^<<<<<</gm) ?? []).length

  if (conflictCount > 0) {
    const header = `Branch '${branch}' has conflicts with ${defaultRemoteRef}.\n\n${conflictCount} conflict(s) detected — ${behind} commit(s) on ${defaultRemoteRef} not yet in this branch.\n\n`
    return blockStopObj(buildConflictReason(header, defaultBranch, defaultRemoteRef))
  }

  if (behind >= STALE_BRANCH_THRESHOLD && mergeTree !== "") {
    const salvageAdvice = skillAdvice(
      "pr-salvage",
      `Use the /pr-salvage skill to recover this stale branch — it can cherry-pick or re-implement the changes on a fresh branch.`,
      `Consider rebasing or re-implementing your changes on a fresh branch — this branch is significantly behind ${defaultRemoteRef}.`
    )
    return blockStopObj(
      `Branch '${branch}' is ${behind} commit(s) behind ${defaultRemoteRef} (threshold: ${STALE_BRANCH_THRESHOLD}).\n\n` +
        `A branch this far behind is at high risk of hidden integration issues even without textual conflicts.\n\n` +
        salvageAdvice
    )
  }

  return {}
}

const stopBranchConflicts: SwizStopHook = {
  name: "stop-branch-conflicts",
  event: "stop",
  timeout: 10,

  run(input) {
    return evaluateStopBranchConflicts(input)
  },
}

export default stopBranchConflicts

if (import.meta.main) {
  await runSwizHookAsMain(stopBranchConflicts)
}
