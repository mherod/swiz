/**
 * Integration point between syncUpstreamState and PR review auto-steer scheduling.
 *
 * Processes sync results and schedules auto-steer payloads into the active
 * session queue when PR reviews or comments change.
 */

import type { UpstreamSyncResult } from "../issue-store.ts"
import { trackPrReviewTransitions } from "./pr-review-tracker.ts"

export interface SyncIntegrationContext {
  /** Enqueue auto-steer payloads to active session. */
  enqueueAutoSteer: (payload: ReturnType<typeof trackPrReviewTransitions>) => void
  /** Whether auto-steer scheduling is enabled for this context. */
  enabled: boolean
}

/**
 * Process sync result for PR review changes and schedule auto-steer.
 *
 * Call this after syncUpstreamState completes to detect and queue review
 * state transitions and new comments as auto-steer payloads.
 *
 * @param result - Sync result from syncUpstreamState
 * @param prData - Current PR objects with review decisions
 * @param commentData - Current comments with PR associations
 * @param ctx - Integration context with enqueue function
 */
export function processSyncForAutoSteer(
  result: UpstreamSyncResult,
  prData: Array<{ number: number; reviewDecision: string | null }>,
  commentData: Array<{ id: string; prNumber: number }>,
  ctx: SyncIntegrationContext
): void {
  if (!ctx.enabled || !result.prBranchDetail?.changes?.length) {
    return
  }

  // Only process if PR branch detail changed
  const payloads = trackPrReviewTransitions(prData, commentData)
  if (payloads.length > 0) {
    ctx.enqueueAutoSteer(payloads)
  }
}

/**
 * Create a sync integration context for a given session.
 *
 * This factory handles the bridge between sync processing and session queue
 * injection, accounting for auto-steer settings.
 *
 * @param sessionId - Current session ID
 * @param autoSteerEnabled - Whether auto-steer is enabled
 * @param onPayloads - Callback when payloads are ready
 * @returns Integration context
 */
export function createSyncIntegrationContext(
  sessionId: string | undefined,
  autoSteerEnabled: boolean,
  onPayloads: (payloads: ReturnType<typeof trackPrReviewTransitions>) => void
): SyncIntegrationContext {
  return {
    enabled: Boolean(sessionId) && autoSteerEnabled,
    enqueueAutoSteer: (payloads) => {
      if (payloads.length > 0) {
        onPayloads(payloads)
      }
    },
  }
}
