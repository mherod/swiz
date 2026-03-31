/**
 * Monitors PR review activity during daemon sync cycles and schedules auto-steer
 * messages when reviews/comments arrive on the current branch's PR.
 *
 * Tracks the previous state of each project's PR to detect new comments and
 * review state transitions (APPROVED, CHANGES_REQUESTED).
 */

import { debugLog } from "../../debug.ts"
import type { IssueStore, UpstreamSyncResult } from "../../issue-store.ts"
import { getIssueStore } from "../../issue-store.ts"
import { extractPrReviewState, scheduleAutoSteerForPrReviews } from "../../pr-review-autosteer.ts"

interface ProjectPrReviewState {
  /** Current branch PR review state */
  state: Record<string, unknown> | null
}

export class PrReviewMonitor {
  private projectStates = new Map<string, ProjectPrReviewState>()
  private store: IssueStore

  constructor(store?: IssueStore) {
    this.store = store ?? getIssueStore()
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

      // Read current state from store
      const rawPrDetail = this.store.getPrBranchDetailRaw(repo, branch)
      const prDetail = rawPrDetail ? JSON.parse(rawPrDetail) : null
      const newState = extractPrReviewState(prDetail)

      // Get previous state
      const key = `${cwd}:${branch}`
      const prevRaw = this.projectStates.get(key)
      const prevState = prevRaw?.state ? extractPrReviewState(prevRaw.state) : null

      // Schedule auto-steer for detected changes
      const updated = await scheduleAutoSteerForPrReviews(
        cwd,
        sessionId,
        syncResult,
        prevState,
        newState
      )

      // Update tracked state
      if (updated) {
        this.projectStates.set(key, { state: prDetail })
      }

      debugLog(
        `[swiz] PR_REVIEW_MONITOR branch=${branch} prev=${JSON.stringify(prevState)} new=${JSON.stringify(newState)}`
      )
    } catch (err) {
      debugLog(`[swiz] PR_REVIEW_MONITOR_ERROR ${err instanceof Error ? err.message : String(err)}`)
      // Fail silently — review monitoring shouldn't block sync
    }
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
  }
}
