/**
 * Local merge validator.
 *
 * Checks for textual conflicts using git merge-tree.
 * Returns conflict count and behind count.
 */

import { git } from "../../src/utils/hook-utils.ts"
import type { BranchCheckContext, GitMergeState } from "./types.ts"

export async function getGitMergeState(ctx: BranchCheckContext): Promise<GitMergeState | null> {
  const originDefault = await git(["rev-parse", ctx.defaultRemoteRef], ctx.cwd)
  if (!originDefault) return null

  const behindStr = await git(["rev-list", "--count", `HEAD..${ctx.defaultRemoteRef}`], ctx.cwd)
  const behind = parseInt(behindStr, 10)
  if (Number.isNaN(behind) || behind === 0) return null

  const mergeBase = await git(["merge-base", "HEAD", ctx.defaultRemoteRef], ctx.cwd)
  if (!mergeBase) return null

  const mergeTree = await git(["merge-tree", mergeBase, "HEAD", ctx.defaultRemoteRef], ctx.cwd)
  const conflictCount = (mergeTree.match(/^<<<<<</gm) ?? []).length

  return {
    conflictCount,
    behindCount: behind,
  }
}

export const STALE_BRANCH_THRESHOLD = 50

export function hasTextualConflicts(merge: GitMergeState | null): boolean {
  return (merge?.conflictCount ?? 0) > 0
}

export function isStaleBranch(merge: GitMergeState | null): boolean {
  return (merge?.behindCount ?? 0) >= STALE_BRANCH_THRESHOLD
}
