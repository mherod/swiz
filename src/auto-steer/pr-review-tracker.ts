/**
 * PR review state-diff engine for auto-steer scheduling.
 *
 * Tracks review decisions and comment IDs across sync cycles.
 * Detects transitions (APPROVED, CHANGES_REQUESTED) and new comments,
 * then emits auto-steer payloads for queue injection.
 */

export type PrReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null

export interface PrReviewState {
  prNumber: number
  reviewDecision: PrReviewDecision
  commentIds: Set<string>
  syncedAt: string
}

export interface AutoSteerPayload {
  type: "PR_COMMENT" | "PR_APPROVAL" | "PR_CHANGES_REQUESTED"
  prNumber: number
  message: string
  timestamp: string
  priority: "high" | "normal"
}

/** In-memory state tracker persisted across sync cycles. */
const prStateHistory = new Map<number, PrReviewState>()

/** Reset tracker state (for testing and explicit state management). */
export function resetPrTrackerState(): void {
  prStateHistory.clear()
}

/**
 * Detect PR review state transitions and new comments.
 *
 * @param currentPrs - PR data from latest sync
 * @param currentComments - Comment data from latest sync
 * @returns Auto-steer payloads to enqueue
 */
export function trackPrReviewTransitions(
  currentPrs: Array<{ number: number; reviewDecision: string | null }>,
  currentComments: Array<{ id: string; prNumber: number }>
): AutoSteerPayload[] {
  const autoSteers: AutoSteerPayload[] = []

  // Diff PR review decisions
  for (const pr of currentPrs) {
    const prev = prStateHistory.get(pr.number)
    const prevDecision = (prev?.reviewDecision ?? null) as PrReviewDecision
    const currDecision = (pr.reviewDecision ?? null) as PrReviewDecision

    // New approval or new changes requested (first time)
    if (
      prevDecision === null &&
      (currDecision === "APPROVED" || currDecision === "CHANGES_REQUESTED")
    ) {
      autoSteers.push({
        type: currDecision === "APPROVED" ? "PR_APPROVAL" : "PR_CHANGES_REQUESTED",
        prNumber: pr.number,
        message:
          currDecision === "APPROVED"
            ? `Pull request #${pr.number} received an approval. You may proceed to merge or address pending items.`
            : `Pull request #${pr.number} has requested changes. Review feedback requires attention before proceeding.`,
        timestamp: new Date().toISOString(),
        priority: currDecision === "CHANGES_REQUESTED" ? "high" : "normal",
      })
    } else if (prevDecision === "CHANGES_REQUESTED" && currDecision === "APPROVED") {
      // Transition from CHANGES_REQUESTED to APPROVED
      autoSteers.push({
        type: "PR_APPROVAL",
        prNumber: pr.number,
        message: `Pull request #${pr.number} previously requested changes, but has now been approved.`,
        timestamp: new Date().toISOString(),
        priority: "high",
      })
    }

    // Update tracked state for this PR
    prStateHistory.set(pr.number, {
      prNumber: pr.number,
      reviewDecision: currDecision,
      commentIds: prev?.commentIds ?? new Set(),
      syncedAt: new Date().toISOString(),
    })
  }

  // Diff comments
  const commentsMap = new Map<number, Set<string>>()
  for (const c of currentComments) {
    if (!commentsMap.has(c.prNumber)) commentsMap.set(c.prNumber, new Set())
    commentsMap.get(c.prNumber)!.add(c.id)
  }

  for (const [prNumber, state] of prStateHistory.entries()) {
    const prComments = commentsMap.get(prNumber) ?? new Set()

    // Detect new comments
    for (const id of prComments) {
      if (!state.commentIds.has(id)) {
        autoSteers.push({
          type: "PR_COMMENT",
          prNumber,
          message: `New comment on pull request #${prNumber}. Review inline feedback.`,
          timestamp: new Date().toISOString(),
          priority: "normal",
        })
      }
    }

    // Sync current comment IDs to state
    state.commentIds = new Set(prComments)
  }

  return autoSteers
}
