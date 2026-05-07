/**
 * Formatting module for branch conflict output.
 *
 * Builds blocking messages for conflicts and diverged branches.
 */

import type { SwizHookOutput } from "../../src/SwizHook.ts"
import { blockStopObj, skillAdvice } from "../../src/utils/hook-utils.ts"
import type { BranchCheckContext, GitHubPRState, GitMergeState } from "./types.ts"

export function buildConflictReason(
  header: string,
  defaultBranch: string,
  defaultRemoteRef: string
): string {
  const fetchRemote = defaultRemoteRef.startsWith("upstream/") ? "upstream" : "origin"
  const rebaseSteps = [
    "We should resolve these conflicts before stopping:",
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

export function buildPRConflictOutput(ctx: BranchCheckContext, pr: GitHubPRState): SwizHookOutput {
  const header = `We should resolve these conflicts: PR #${pr.number} for branch '${ctx.branch}' has merge conflicts (GitHub: mergeable=CONFLICTING, mergeStateStatus=${pr.mergeStateStatus}).\n\n${pr.url}\n\n`
  return blockStopObj(buildConflictReason(header, ctx.defaultBranch, ctx.defaultRemoteRef))
}

export function buildTextualConflictOutput(
  ctx: BranchCheckContext,
  merge: GitMergeState
): SwizHookOutput {
  const header = `We should resolve these conflicts: branch '${ctx.branch}' conflicts with ${ctx.defaultRemoteRef}.\n\n${merge.conflictCount} conflict(s) detected — ${merge.behindCount} commit(s) on ${ctx.defaultRemoteRef} not yet in this branch.\n\n`
  return blockStopObj(buildConflictReason(header, ctx.defaultBranch, ctx.defaultRemoteRef))
}

export function buildStaleBranchOutput(
  ctx: BranchCheckContext,
  merge: GitMergeState,
  threshold: number
): SwizHookOutput {
  const salvageAdvice = skillAdvice(
    "pr-salvage",
    `Use the /pr-salvage skill to recover this stale branch — it can cherry-pick or re-implement the changes on a fresh branch.`,
    `Consider rebasing or re-implementing your changes on a fresh branch — this branch is significantly behind ${ctx.defaultRemoteRef}.`
  )
  return blockStopObj(
    `Branch '${ctx.branch}' is ${merge.behindCount} commit(s) behind ${ctx.defaultRemoteRef} (threshold: ${threshold}).\n\n` +
      `A branch this far behind is at high risk of hidden integration issues even without textual conflicts.\n\n` +
      salvageAdvice
  )
}
