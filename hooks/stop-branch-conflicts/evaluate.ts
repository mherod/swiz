/**
 * Main orchestration module for stop-branch-conflicts.
 *
 * Resolves context, runs validators, and returns blocking output or empty object.
 */

import type { SwizHookOutput } from "../../src/SwizHook.ts"
import type { StopHookInput } from "../../src/schemas.ts"
import { readProjectSettings } from "../../src/settings.ts"
import { evaluateWorktreePreservation } from "../../src/worktree-preservation.ts"
import {
  buildPRConflictOutput,
  buildStaleBranchOutput,
  buildTextualConflictOutput,
} from "./action-plan.ts"
import { resolveBranchCheckContext } from "./context.ts"
import { getGitHubPRState, isPRConflicting, isPRMergeable } from "./github-pr-validator.ts"
import {
  getGitMergeState,
  hasTextualConflicts,
  isStaleBranch,
  STALE_BRANCH_THRESHOLD,
} from "./local-merge-validator.ts"
import type { BranchCheckContext } from "./types.ts"

async function preservesConflictViaPr(ctx: BranchCheckContext): Promise<boolean> {
  const trunkMode = (await readProjectSettings(ctx.cwd))?.trunkMode === true
  const decision = await evaluateWorktreePreservation({
    cwd: ctx.cwd,
    branch: ctx.branch,
    defaultBranch: ctx.defaultBranch,
    trunkMode,
    conflictsWithDefault: true,
  })
  return decision.preserveViaPr
}

/**
 * Evaluate branch conflicts and return blocking output or empty object.
 */
export async function evaluateStopBranchConflicts(input: StopHookInput): Promise<SwizHookOutput> {
  const ctx = await resolveBranchCheckContext(input)
  if (!ctx) return {}

  // Check GitHub PR state first (authoritative)
  const pr = await getGitHubPRState(ctx)
  if (isPRConflicting(pr)) {
    if (await preservesConflictViaPr(ctx)) return {}
    return buildPRConflictOutput(ctx, pr!)
  }
  if (isPRMergeable(pr)) return {}

  // Fallback: check local merge-tree for conflicts
  const merge = await getGitMergeState(ctx)
  if (!merge) return {}

  if (hasTextualConflicts(merge)) {
    if (await preservesConflictViaPr(ctx)) return {}
    return buildTextualConflictOutput(ctx, merge)
  }

  if (isStaleBranch(merge)) {
    return buildStaleBranchOutput(ctx, merge, STALE_BRANCH_THRESHOLD)
  }

  return {}
}
