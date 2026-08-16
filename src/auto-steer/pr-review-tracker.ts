/**
 * PR review state-diff engine for auto-steer scheduling.
 *
 * Tracks review decisions and comment IDs across sync cycles.
 * Detects transitions (APPROVED, CHANGES_REQUESTED) and new comments,
 * then emits auto-steer payloads for queue injection.
 */

import { CappedMap } from "../utils/capped-map.ts"

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
const prStateHistory = new CappedMap<number, PrReviewState>(1000)

/** Evict entries not seen in the last 7 days. */
const PR_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Max comments to track per PR to avoid memory bloat. */
const MAX_COMMENTS_PER_PR = 100

/** Reset tracker state (for testing and explicit state management). */
export function resetPrTrackerState(): void {
  prStateHistory.clear()
}

function evictStalePrStates(nowMs: number): void {
  if (Math.random() >= 0.1) return
  for (const [prNumber, state] of prStateHistory.entries()) {
    if (nowMs - new Date(state.syncedAt).getTime() > PR_STATE_TTL_MS) {
      prStateHistory.delete(prNumber)
    }
  }
}

function buildCommentLookup(
  currentPrs: Array<{ number: number; reviewDecision: string | null }>,
  currentComments: Array<{ id: string; prNumber: number }>
): Map<number, Set<string>> {
  const syncedPrNumbers = new Set(currentPrs.map((p) => p.number))
  const commentsMap = new Map<number, Set<string>>()
  for (const c of currentComments) {
    if (!syncedPrNumbers.has(c.prNumber)) continue
    let set = commentsMap.get(c.prNumber)
    if (!set) {
      set = new Set()
      commentsMap.set(c.prNumber, set)
    }
    if (set.size < MAX_COMMENTS_PER_PR) {
      set.add(c.id)
    }
  }
  return commentsMap
}

function detectDecisionTransition(
  prNumber: number,
  prevDecision: PrReviewDecision,
  currDecision: PrReviewDecision,
  now: string
): AutoSteerPayload | null {
  if (
    prevDecision === null &&
    (currDecision === "APPROVED" || currDecision === "CHANGES_REQUESTED")
  ) {
    const isApproved = currDecision === "APPROVED"
    return {
      type: isApproved ? "PR_APPROVAL" : "PR_CHANGES_REQUESTED",
      prNumber,
      message: isApproved
        ? `Pull request #${prNumber} received an approval. You may proceed to merge or address pending items.`
        : `Pull request #${prNumber} has requested changes. Review feedback requires attention before proceeding.`,
      timestamp: now,
      priority: isApproved ? "normal" : "high",
    }
  }
  if (prevDecision === "CHANGES_REQUESTED" && currDecision === "APPROVED") {
    return {
      type: "PR_APPROVAL",
      prNumber,
      message: `Pull request #${prNumber} previously requested changes, but has now been approved.`,
      timestamp: now,
      priority: "high",
    }
  }
  return null
}

function detectCommentTransition(
  prNumber: number,
  prev: PrReviewState | undefined,
  currentCommentIds: Set<string>,
  now: string
): AutoSteerPayload | null {
  if (!prev) return null
  let newCount = 0
  for (const id of currentCommentIds) {
    if (!prev.commentIds.has(id)) newCount++
  }
  if (newCount === 0) return null
  return {
    type: "PR_COMMENT",
    prNumber,
    message:
      newCount === 1
        ? `New comment on pull request #${prNumber}. Review inline feedback.`
        : `${newCount} new comments on pull request #${prNumber}. Review inline feedback.`,
    timestamp: now,
    priority: "normal",
  }
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
  const now = new Date().toISOString()
  const nowMs = Date.now()

  evictStalePrStates(nowMs)
  const commentsMap = buildCommentLookup(currentPrs, currentComments)

  // Diff PR review decisions and comments
  for (const pr of currentPrs) {
    const prev = prStateHistory.get(pr.number)
    const prevDecision = (prev?.reviewDecision ?? null) as PrReviewDecision
    const currDecision = (pr.reviewDecision ?? null) as PrReviewDecision

    const decisionPayload = detectDecisionTransition(pr.number, prevDecision, currDecision, now)
    if (decisionPayload) {
      autoSteers.push(decisionPayload)
    }

    const currentCommentIds = commentsMap.get(pr.number) ?? new Set<string>()
    const commentPayload = detectCommentTransition(pr.number, prev, currentCommentIds, now)
    if (commentPayload) {
      autoSteers.push(commentPayload)
    }

    prStateHistory.set(pr.number, {
      prNumber: pr.number,
      reviewDecision: currDecision,
      commentIds: currentCommentIds,
      syncedAt: now,
    })
  }

  return autoSteers
}
