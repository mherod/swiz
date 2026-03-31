// noinspection JSUnusedGlobalSymbols

import { debugLog } from "../../debug.ts"
import {
  getIssueStore,
  type IssueStore,
  replayPendingMutations,
  syncUpstreamState,
  type UpstreamSyncResult,
} from "../../issue-store.ts"

const DEFAULT_SYNC_INTERVAL_MS = 2 * 60 * 1000 // 2 minutes
const DEFAULT_SYNC_TIMEOUT_MS = 30 * 1000 // 30 seconds

export interface UpstreamSyncStatus {
  repo: string
  cwd: string
  lastSyncAt: number | null
  lastResult: UpstreamSyncResult | null
  syncing: boolean
}

interface SyncEntry {
  repo: string
  cwd: string
  lastSyncAt: number | null
  lastResult: UpstreamSyncResult | null
  syncing: boolean
  timer: ReturnType<typeof setTimeout> | null
}

type RepoSlugResolver = (cwd: string) => Promise<string | null>

export class UpstreamSyncRegistry {
  private entries = new Map<string, SyncEntry>()
  private readonly intervalMs: number
  private readonly timeoutMs: number
  private readonly resolveSlug: RepoSlugResolver
  private readonly store: IssueStore | null

  constructor(opts?: {
    intervalMs?: number
    timeoutMs?: number
    resolveSlug?: RepoSlugResolver
    store?: IssueStore
  }) {
    this.intervalMs = opts?.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS
    this.resolveSlug = opts?.resolveSlug ?? defaultResolveSlug
    this.store = opts?.store ?? null
  }

  /** Register a project for periodic upstream sync. Idempotent.
   *  For fork workflows, also registers the upstream (parent) repo so
   *  its issues, labels, and milestones are synced alongside the fork's PRs/CI. */
  async register(cwd: string): Promise<{ deduped: boolean }> {
    if (this.entries.has(cwd)) return { deduped: true }

    const repo = await this.resolveSlug(cwd)
    if (!repo) return { deduped: false }

    const entry: SyncEntry = {
      repo,
      cwd,
      lastSyncAt: null,
      lastResult: null,
      syncing: false,
      timer: null,
    }
    this.entries.set(cwd, entry)
    this.scheduleSync(cwd)

    // Fork workflow: also register the upstream repo for issue/label/milestone sync
    const { detectForkTopology } = await import("../../git-helpers.ts")
    const fork = await detectForkTopology(cwd)
    if (fork && fork.upstreamSlug !== repo) {
      const upstreamKey = `${cwd}::upstream`
      if (!this.entries.has(upstreamKey)) {
        const upstreamEntry: SyncEntry = {
          repo: fork.upstreamSlug,
          cwd,
          lastSyncAt: null,
          lastResult: null,
          syncing: false,
          timer: null,
        }
        this.entries.set(upstreamKey, upstreamEntry)
        this.scheduleSync(upstreamKey)
      }
    }

    return { deduped: false }
  }

  /** Trigger an immediate sync for a project. */
  async syncNow(cwd: string): Promise<UpstreamSyncResult | null> {
    const entry = this.entries.get(cwd)
    if (!entry) return null
    return this.doSync(entry)
  }

  listActive(): UpstreamSyncStatus[] {
    return [...this.entries.values()].map((e) => ({
      repo: e.repo,
      cwd: e.cwd,
      lastSyncAt: e.lastSyncAt,
      lastResult: e.lastResult,
      syncing: e.syncing,
    }))
  }

  /** Stop the periodic sync timer and remove a single project. */
  unregister(cwd: string): boolean {
    const entry = this.entries.get(cwd)
    if (!entry) return false
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    this.entries.delete(cwd)
    return true
  }

  close(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = null
    }
    this.entries.clear()
  }

  private scheduleSync(cwd: string): void {
    const entry = this.entries.get(cwd)
    if (!entry) return
    entry.timer = setTimeout(() => {
      void this.doSync(entry).then(() => this.scheduleSync(cwd))
    }, this.intervalMs)
  }

  // In-flight coalescing: concurrent doSync calls for the same entry share one computation.
  private inFlightSyncs = new Map<string, Promise<UpstreamSyncResult>>()

  private async doSync(entry: SyncEntry): Promise<UpstreamSyncResult> {
    // Join existing in-flight computation rather than firing a duplicate gh call.
    const inflight = this.inFlightSyncs.get(entry.cwd)
    if (inflight) return inflight

    const computation = this.runSync(entry)
    this.inFlightSyncs.set(entry.cwd, computation)
    return computation.finally(() => this.inFlightSyncs.delete(entry.cwd))
  }

  private async runSync(entry: SyncEntry): Promise<UpstreamSyncResult> {
    entry.syncing = true
    try {
      const result = await Promise.race([
        syncUpstreamState(entry.repo, entry.cwd, { store: this.store ?? undefined }),
        new Promise<UpstreamSyncResult>((_, reject) =>
          setTimeout(() => reject(new Error("sync timeout")), this.timeoutMs)
        ),
      ])
      entry.lastSyncAt = Date.now()
      entry.lastResult = result
      debugLog(
        `[swiz] UPSTREAM_SYNC repo=${entry.repo} issues=${result.issues.upserted} prs=${result.pullRequests.upserted} ci=${result.ciStatuses.upserted} labels=${result.labels.upserted} milestones=${result.milestones.upserted} branchCi=${result.branchCi.upserted} prBranchDetail=${result.prBranchDetail.upserted} removed_issues=${result.issues.removed} removed_prs=${result.pullRequests.removed}`
      )
      // Drain any queued offline mutations now that we have a live connection.
      const store = this.store ?? getIssueStore()
      const pending = store.pendingCount(entry.repo)
      if (pending > 0) {
        debugLog(`[swiz] UPSTREAM_SYNC replaying ${pending} pending mutations for ${entry.repo}`)
        await replayPendingMutations(entry.repo, entry.cwd, store)
      }
      return result
    } catch (err) {
      debugLog(
        `[swiz] UPSTREAM_SYNC_ERROR repo=${entry.repo} ${err instanceof Error ? err.message : String(err)}`
      )
      const emptyBucket = () => ({ upserted: 0, removed: 0, skipped: 0, changes: [] })
      const emptyTracked = () => ({ upserted: 0, changes: [] })
      return (
        entry.lastResult ?? {
          issues: emptyBucket(),
          pullRequests: emptyBucket(),
          ciStatuses: emptyTracked(),
          comments: { upserted: 0 },
          labels: emptyBucket(),
          milestones: emptyBucket(),
          branchCi: emptyTracked(),
          prBranchDetail: emptyTracked(),
          branchProtection: emptyTracked(),
        }
      )
    } finally {
      entry.syncing = false
    }
  }
}

async function defaultResolveSlug(cwd: string): Promise<string | null> {
  const { getRepoSlug, isGitRepo, hasGhCli } = await import("../../git-helpers.ts")
  if (!hasGhCli()) return null
  if (!(await isGitRepo(cwd))) return null
  return getRepoSlug(cwd)
}
