/**
 * PR review activity detection and auto-steer scheduling.
 *
 * Monitors changes to PR reviews (comments, state transitions) during
 * daemon sync cycles and schedules auto-steer messages for the current session.
 */

import { git } from "./git-helpers.ts"
import type { UpstreamSyncResult } from "./issue-store.ts"

export interface PrReviewState {
  /** Review decision state: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, null */
  reviewDecision: string | null
  /** Count of comments on the PR */
  commentCount: number
}

/**
 * Extract review state from a PR's branch detail cache entry.
 * Returns null if the branch has no associated PR or isn't synced yet.
 */
export function extractPrReviewState(prBranchDetail: unknown): PrReviewState | null {
  if (!prBranchDetail || typeof prBranchDetail !== "object") return null
  const detail = prBranchDetail as Record<string, any>
  return {
    reviewDecision: (detail.reviewDecision as string) ?? null,
    commentCount: (detail.commentCount as number) ?? 0,
  }
}

/**
 * Detect review state changes and schedule auto-steer messages.
 *
 * Compares the current branch's PR state against the sync result and
 * schedules appropriate auto-steer messages for new reviews or comments.
 *
 * @param cwd - Working directory
 * @param sessionId - Current session ID (for auto-steer scheduling)
 * @param syncResult - Results from `syncUpstreamState()`
 * @param prevState - Previous PR review state (from last sync)
 * @param newState - New PR review state (resolved from store after sync)
 * @returns Updated PR review state, or null if no PR on current branch
 */
export async function scheduleAutoSteerForPrReviews(
  cwd: string,
  sessionId: string | undefined,
  syncResult: UpstreamSyncResult,
  prevState: PrReviewState | null,
  newState: PrReviewState | null
): Promise<PrReviewState | null> {
  if (!sessionId || !newState) return newState

  // Resolve current branch
  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return newState

  // Check if PR branch detail changed in this sync
  if (!syncResult.prBranchDetail?.changes?.length) return newState

  const branchChange = syncResult.prBranchDetail.changes.find((c) => c.key === branch)
  if (!branchChange) return newState

  // Detect transitions and schedule auto-steer
  const prevDecision = prevState?.reviewDecision ?? null
  const newDecision = newState.reviewDecision ?? null

  // New approval
  if (prevDecision !== "APPROVED" && newDecision === "APPROVED") {
    const { scheduleAutoSteer } = await import("./utils/auto-steer-helpers.ts")
    await scheduleAutoSteer(sessionId, formatReviewStateMessage("APPROVED"), "next_turn", cwd)
  }

  // Changes requested (new state)
  if (prevDecision !== "CHANGES_REQUESTED" && newDecision === "CHANGES_REQUESTED") {
    const { scheduleAutoSteer } = await import("./utils/auto-steer-helpers.ts")
    await scheduleAutoSteer(
      sessionId,
      formatReviewStateMessage("CHANGES_REQUESTED"),
      "next_turn",
      cwd
    )
  }

  // New comment
  const prevCommentCount = prevState?.commentCount ?? 0
  const newCommentCount = newState.commentCount ?? 0
  if (newCommentCount > prevCommentCount) {
    const { scheduleAutoSteer } = await import("./utils/auto-steer-helpers.ts")
    const commentDelta = newCommentCount - prevCommentCount
    await scheduleAutoSteer(sessionId, formatNewCommentMessage(commentDelta), "next_turn", cwd)
  }

  return newState
}

/**
 * Format an auto-steer message for a new comment on the current PR.
 *
 * @param commentCount - Number of new comments
 * @returns Auto-steer message text
 */
export function formatNewCommentMessage(commentCount: number): string {
  if (commentCount === 1) {
    return "A reviewer left a comment on your PR."
  }
  return `${commentCount} new comments on your PR.`
}

/**
 * Format an auto-steer message for a review state change.
 *
 * @param state - New review state (APPROVED, CHANGES_REQUESTED, etc.)
 * @returns Auto-steer message text
 */
export function formatReviewStateMessage(state: string): string {
  if (state === "APPROVED") {
    return "Your PR was approved!"
  }
  if (state === "CHANGES_REQUESTED") {
    return "Reviewer requested changes on your PR."
  }
  if (state === "REVIEW_REQUIRED") {
    return "Review required before merge."
  }
  return `Review state: ${state}`
}
