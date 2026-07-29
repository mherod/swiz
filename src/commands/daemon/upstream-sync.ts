// noinspection JSUnusedGlobalSymbols

import { debugLog } from "../../debug.ts"
import {
  getIssueStore,
  type IssueStore,
  replayPendingMutations,
  syncUpstreamState,
  type UpstreamSyncResult,
} from "../../issue-store.ts"
import { messageFromUnknownError } from "../../utils/hook-json-helpers.ts"
import { isRegisterableProjectCwd } from "./route-helpers.ts"

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
type ForkTopologyResolver = (cwd: string) => Promise<{ upstreamSlug: string } | null>
type SyncRunner = typeof syncUpstreamState

export class UpstreamSyncRegistry {
  private entries = new Map<string, SyncEntry>()
  private readonly intervalMs: number
  private readonly timeoutMs: number
  private readonly resolveSlug: RepoSlugResolver
  private readonly resolveFork: ForkTopologyResolver
  private readonly sync: SyncRunner
  private readonly store: IssueStore | null

  constructor(opts?: {
    intervalMs?: number
    timeoutMs?: number
    resolveSlug?: RepoSlugResolver
    resolveFork?: ForkTopologyResolver
    sync?: SyncRunner
    store?: IssueStore
  }) {
    const {
      intervalMs = DEFAULT_SYNC_INTERVAL_MS,
      timeoutMs = DEFAULT_SYNC_TIMEOUT_MS,
      resolveSlug = defaultResolveSlug,
      resolveFork = defaultResolveFork,
      sync = syncUpstreamState,
      store = null,
    } = opts ?? {}
    this.intervalMs = intervalMs
    this.timeoutMs = timeoutMs
    this.resolveSlug = resolveSlug
    this.resolveFork = resolveFork
    this.sync = sync
    this.store = store
  }

  /** Register a project for periodic upstream sync. Idempotent.
   *  For fork workflows, also registers the upstream (parent) repo so
   *  its issues, labels, and milestones are synced alongside the fork's PRs/CI. */
  async register(cwd: string): Promise<{ deduped: boolean }> {
    // Placeholder/relative cwds (e.g. "." from DaemonBackedIssueStore) must not
    // become sync entries — they resolve against the daemon's own cwd and spawn
    // a duplicate loop, and a persisted "." cursor would resurrect it on every
    // startup via restoreKnownRepos (#716).
    if (!isRegisterableProjectCwd(cwd)) return { deduped: false }
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
    const fork = await this.resolveFork(cwd)
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

  /**
   * Re-register all repos previously synced by reading the `cwd` cursor written
   * by `syncUpstreamState`. Called on daemon startup so background sync resumes
   * for every repo in the issue store without waiting for a dispatch to arrive.
   */
  async restoreKnownRepos(): Promise<void> {
    const { getIssueStore } = await import("../../issue-store.ts")
    const known = getIssueStore().listKnownRepoCwds()
    await Promise.all(known.map(({ cwd }) => this.register(cwd)))
  }

  /** Trigger an immediate sync for a project. */
  async syncNow(cwd: string): Promise<UpstreamSyncResult | null> {
    const entry = this.entries.get(cwd)
    if (!entry) return null
    return this.doSync(cwd, entry)
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

  /** Stop periodic sync timers and remove a project plus its fork-upstream entry. */
  unregister(cwd: string): boolean {
    let removed = false
    for (const entryKey of [cwd, `${cwd}::upstream`]) {
      const entry = this.entries.get(entryKey)
      if (!entry) continue
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = null
      this.entries.delete(entryKey)
      removed = true
    }
    return removed
  }

  close(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = null
    }
    this.entries.clear()
  }

  private scheduleSync(entryKey: string): void {
    const entry = this.entries.get(entryKey)
    if (!entry) return
    entry.timer = setTimeout(() => {
      void this.doSync(entryKey, entry).then(() => this.scheduleSync(entryKey))
    }, this.intervalMs)
  }

  // In-flight coalescing: concurrent doSync calls for the same entry share one computation.
  private inFlightSyncs = new Map<string, Promise<UpstreamSyncResult>>()

  private async doSync(entryKey: string, entry: SyncEntry): Promise<UpstreamSyncResult> {
    // Join existing in-flight computation rather than firing a duplicate gh call.
    const inflight = this.inFlightSyncs.get(entryKey)
    if (inflight) return inflight

    const computation = this.runSync(entry)
    this.inFlightSyncs.set(entryKey, computation)
    return computation.finally(() => this.inFlightSyncs.delete(entryKey))
  }

  private async runSync(entry: SyncEntry): Promise<UpstreamSyncResult> {
    entry.syncing = true
    try {
      const result = await Promise.race([
        this.sync(entry.repo, entry.cwd, { store: this.store ?? undefined }),
        new Promise<UpstreamSyncResult>((_, reject) =>
          setTimeout(() => reject(new Error("sync timeout")), this.timeoutMs)
        ),
      ])
      // Only stamp lastSyncAt on a real success — a sync where every fetch
      // returned null must not report as fresh to status/staleness consumers (#715).
      if (result.fetchOk) entry.lastSyncAt = Date.now()
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
      debugLog(`[swiz] UPSTREAM_SYNC_ERROR repo=${entry.repo} ${messageFromUnknownError(err)}`)
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
          events: { inserted: 0, cursor: null },
          restCache: { requests: 0, notModified: 0, writes: 0 },
          fetchOk: false,
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

async function defaultResolveFork(cwd: string): Promise<{ upstreamSlug: string } | null> {
  const { detectForkTopology } = await import("../../git-helpers.ts")
  return detectForkTopology(cwd)
}
