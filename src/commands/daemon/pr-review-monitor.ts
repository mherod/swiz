/**
 * Monitors PR review activity during daemon sync cycles and schedules auto-steer
 * messages when reviews/comments arrive on the current branch's PR.
 *
 * Tracks the previous state of each project's PR to detect new comments and
 * review state transitions (APPROVED, CHANGES_REQUESTED).
 */

import type { trackPrReviewTransitions } from "../../auto-steer/pr-review-tracker.ts"
import { createSyncIntegrationContext } from "../../auto-steer/sync-integration.ts"
import { debugLog } from "../../debug.ts"
import type { IssueStore, UpstreamSyncResult } from "../../issue-store.ts"
import { getIssueStore } from "../../issue-store.ts"

interface ProjectPrReviewState {
  /** Current branch PR review state */
  prDetail: Record<string, any> | null
}

interface SessionAutoSteerQueue {
  payloads: ReturnType<typeof trackPrReviewTransitions>
}

export class PrReviewMonitor {
  private projectStates = new Map<string, ProjectPrReviewState>()
  private sessionQueues = new Map<string, SessionAutoSteerQueue>()
  private store: IssueStore

  constructor(store?: IssueStore) {
    this.store = store ?? getIssueStore()
  }

  /**
   * Get auto-steer payloads queued for a session.
   * Call during session lifecycle to retrieve and clear pending payloads.
   */
  getAndClearSessionQueue(sessionId: string): ReturnType<typeof trackPrReviewTransitions> {
    const queue = this.sessionQueues.get(sessionId)
    if (!queue) return []
    this.sessionQueues.delete(sessionId)
    return queue.payloads
  }

  /**
   * Process a sync result and schedule auto-steer if PR reviews changed.
   *
   * @param cwd - Project working directory
   * @param sessionId - Current session ID (for auto-steer scheduling)
   * @param repo - Repository slug
   * @param syncResult - Results from `syncUpstreamState()`
   */
  async processSyncResult(
    cwd: string,
    sessionId: string | undefined,
    repo: string,
    syncResult: UpstreamSyncResult
  ): Promise<void> {
    try {
      // Only process if PR branch detail changed
      if (!syncResult.prBranchDetail?.changes?.length) return

      const { git } = await import("../../git-helpers.ts")
      const branch = await git(["branch", "--show-current"], cwd)
      if (!branch) return

      // Find if this branch had PR detail changes
      const branchChange = syncResult.prBranchDetail.changes.find((c) => c.key === branch)
      if (!branchChange) return

      // Extract PR data for current branch and comments from store
      // Get open PRs to extract reviewDecision
      const openPrs = this.store.listPullRequests(repo) as
        | Array<{
            number: number
            reviewDecision: string | null
          }>
        | undefined
      if (!openPrs) return

      // Comments are stored per-issue number in the store
      const allComments: Array<{ id: string; prNumber: number }> = []
      for (const pr of openPrs) {
        const comments = this.store.listIssueComments<{ id: string }>(repo, pr.number)
        if (comments) {
          for (const c of comments) {
            allComments.push({
              id: c.id,
              prNumber: pr.number,
            })
          }
        }
      }

      // Build integration context
      const ctx = createSyncIntegrationContext(sessionId, true, (payloads) => {
        if (sessionId && payloads.length > 0) {
          // Store payloads in session queue for retrieval during lifecycle
          const existing = this.sessionQueues.get(sessionId) ?? { payloads: [] }
          existing.payloads.push(...payloads)
          this.sessionQueues.set(sessionId, existing)
        }
      })

      // Process through tracker
      const { processSyncForAutoSteer } = await import("../../auto-steer/sync-integration.ts")
      processSyncForAutoSteer(syncResult, openPrs, allComments, ctx)

      // Update state tracker with new PR detail for this branch
      const rawPrDetail = this.store.getPrBranchDetailRaw(repo, branch)
      const key = `${cwd}:${branch}`
      if (rawPrDetail) {
        const prDetail = JSON.parse(rawPrDetail)
        this.projectStates.set(key, { prDetail })
      } else {
        this.projectStates.delete(key)
      }

      debugLog(
        `[swiz] PR_REVIEW_MONITOR branch=${branch} processed openPrs=${openPrs.length} comments=${allComments.length}`
      )
    } catch (err) {
      debugLog(`[swiz] PR_REVIEW_MONITOR_ERROR ${err instanceof Error ? err.message : String(err)}`)
      // Fail silently — review monitoring shouldn't block sync
    }
  }

  /**
   * Get and clear auto-steer payloads for a session.
   * Called during session lifecycle to flush queued payloads.
   */
  consumeSessionQueue(sessionId: string): ReturnType<typeof trackPrReviewTransitions> {
    const queue = this.sessionQueues.get(sessionId)
    if (!queue) return []
    this.sessionQueues.delete(sessionId)
    return queue.payloads
  }

  /** Clear cached state for a project (e.g., when unregistering). */
  clearProject(cwd: string): void {
    for (const key of this.projectStates.keys()) {
      if (key.startsWith(cwd)) {
        this.projectStates.delete(key)
      }
    }
  }

  /** Purge all cached state. */
  clear(): void {
    this.projectStates.clear()
    this.sessionQueues.clear()
  }
}
