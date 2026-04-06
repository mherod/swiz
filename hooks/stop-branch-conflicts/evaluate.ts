/**
 * Main orchestration module for stop-branch-conflicts.
 *
 * Resolves context, runs validators, and returns blocking output or empty object.
 */

import type { SwizHookOutput } from "../../src/SwizHook.ts"
import type { StopHookInput } from "../../src/schemas.ts"
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

/**
 * Evaluate branch conflicts and return blocking output or empty object.
 */
export async function evaluateStopBranchConflicts(input: StopHookInput): Promise<SwizHookOutput> {
  const ctx = await resolveBranchCheckContext(input)
  if (!ctx) return {}

  // Check GitHub PR state first (authoritative)
  const pr = await getGitHubPRState(ctx)
  if (isPRConflicting(pr)) {
    return buildPRConflictOutput(ctx, pr!)
  }
  if (isPRMergeable(pr)) return {}

  // Fallback: check local merge-tree for conflicts
  const merge = await getGitMergeState(ctx)
  if (!merge) return {}

  if (hasTextualConflicts(merge)) {
    return buildTextualConflictOutput(ctx, merge)
  }

  if (isStaleBranch(merge)) {
    return buildStaleBranchOutput(ctx, merge, STALE_BRANCH_THRESHOLD)
  }

  return {}
}
