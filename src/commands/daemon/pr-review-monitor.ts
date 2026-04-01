/**
 * Monitors PR review activity during daemon sync cycles and schedules auto-steer
 * messages when reviews/comments arrive on the current branch's PR.
 *
 * Tracks the previous state of each project's PR to detect new comments and
 * review state transitions (APPROVED, CHANGES_REQUESTED).
 */

import type { trackPrReviewTransitions } from "../../auto-steer/pr-review-tracker.ts"
import {
  createSyncIntegrationContext,
  processSyncForAutoSteer,
} from "../../auto-steer/sync-integration.ts"
import { debugLog } from "../../debug.ts"
import { git } from "../../git-helpers.ts"
import type { IssueStore, UpstreamSyncResult } from "../../issue-store.ts"
import { getIssueStore } from "../../issue-store.ts"

const BRANCH_CACHE_TTL_MS = 15_000

interface BranchCacheEntry {
  branch: string
  cachedAt: number
}

interface SessionAutoSteerQueue {
  payloads: ReturnType<typeof trackPrReviewTransitions>
}

export class PrReviewMonitor {
  private branchCache = new Map<string, BranchCacheEntry>()
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

      const branch = await this.getCurrentBranch(cwd)
      if (!branch) return

      // Find if this branch had PR detail changes
      const branchChange = syncResult.prBranchDetail.changes.find((c) => c.key === branch)
      if (!branchChange) return

      // Get open PRs (only number + reviewDecision needed)
      const openPrs = this.store.listPullRequests(repo) as
        | Array<{ number: number; reviewDecision: string | null }>
        | undefined
      if (!openPrs) return

      // Fetch all comments for this repo in a single query
      const allComments = this.store.listAllIssueCommentIds(repo)

      // Build integration context and process
      const ctx = createSyncIntegrationContext(sessionId, true, (payloads) => {
        if (sessionId && payloads.length > 0) {
          const existing = this.sessionQueues.get(sessionId) ?? { payloads: [] }
          existing.payloads.push(...payloads)
          this.sessionQueues.set(sessionId, existing)
        }
      })

      processSyncForAutoSteer(syncResult, openPrs, allComments, ctx)

      debugLog(
        `[swiz] PR_REVIEW_MONITOR branch=${branch} processed openPrs=${openPrs.length} comments=${allComments.length}`
      )
    } catch (err) {
      debugLog(`[swiz] PR_REVIEW_MONITOR_ERROR ${err instanceof Error ? err.message : String(err)}`)
      // Fail silently — review monitoring shouldn't block sync
    }
  }

  /** Return current branch for cwd, cached for BRANCH_CACHE_TTL_MS. */
  private async getCurrentBranch(cwd: string): Promise<string | null> {
    const now = Date.now()
    const cached = this.branchCache.get(cwd)
    if (cached && now - cached.cachedAt < BRANCH_CACHE_TTL_MS) return cached.branch
    const branch = await git(["branch", "--show-current"], cwd)
    if (branch) this.branchCache.set(cwd, { branch, cachedAt: now })
    return branch || null
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

  /** Remove queued payloads for sessions no longer active. */
  pruneOldSessions(activeSessions: Set<string>): void {
    for (const sessionId of this.sessionQueues.keys()) {
      if (!activeSessions.has(sessionId)) {
        this.sessionQueues.delete(sessionId)
      }
    }
  }

  /** Clear branch cache for a project (e.g., when unregistering). */
  clearProject(cwd: string): void {
    this.branchCache.delete(cwd)
  }

  /** Purge all cached state. */
  clear(): void {
    this.branchCache.clear()
    this.sessionQueues.clear()
  }
}
