// noinspection JSUnusedGlobalSymbols

import { debugLog } from "../../debug.ts"
import {
  getIssueStore,
  type IssueStore,
  replayPendingMutations,
  syncUpstreamState,
  type UpstreamSyncResult,
} from "../../issue-store.ts"
import { canonicalizePath, isPathWithinRoot, resolveProjectRoot } from "../../project-identity.ts"
import {
  type RepositoryCapability,
  resolveRepositoryCapability,
} from "../../repository-capability.ts"
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
  /** Canonical repository root this entry is keyed on — never a raw caller cwd. */
  cwd: string
  lastSyncAt: number | null
  lastResult: UpstreamSyncResult | null
  syncing: boolean
  timer: ReturnType<typeof setTimeout> | null
}

type RepoSlugResolver = (cwd: string) => Promise<string | null>
type RepositoryCapabilityResolver = (cwd: string) => Promise<RepositoryCapability>
type ForkTopologyResolver = (cwd: string) => Promise<{ upstreamSlug: string } | null>
type SyncRunner = typeof syncUpstreamState
type RegistrationResult = { deduped: boolean; registered: boolean }

function toSyncStatus(entry: SyncEntry): UpstreamSyncStatus {
  return {
    repo: entry.repo,
    cwd: entry.cwd,
    lastSyncAt: entry.lastSyncAt,
    lastResult: entry.lastResult,
    syncing: entry.syncing,
  }
}

export class UpstreamSyncRegistry {
  private entries = new Map<string, SyncEntry>()
  // Registration coalescing: concurrent register() calls for cwd variants that
  // resolve to one root share a single computation. See register().
  private inFlightRegistrations = new Map<string, Promise<RegistrationResult>>()
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
  async register(cwd: string): Promise<RegistrationResult> {
    // Placeholder/relative cwds (e.g. "." from DaemonBackedIssueStore) must not
    // become sync entries — they resolve against the daemon's own cwd and spawn
    // a duplicate loop, and a persisted "." cursor would resurrect it on every
    // startup via restoreKnownRepos (#716).
    if (!isRegisterableProjectCwd(cwd)) return { deduped: false, registered: false }

    // Key on the repository root, not the cwd we happened to be handed. `/path`,
    // `/path/`, a symlink alias, and `/path/subdir` all name one project; keying
    // raw gave each its own independent 2-minute sync loop (#717).
    const canonicalRoot = await resolveProjectRoot(cwd)
    if (this.entries.has(canonicalRoot)) return { deduped: true, registered: true }

    // restoreKnownRepos() registers every stored cursor concurrently, so two
    // legacy cwd variants collapsing to the same root can both clear the check
    // above before either writes its entry. Share one registration per root so
    // the loser dedupes instead of spawning a rival loop.
    const inflight = this.inFlightRegistrations.get(canonicalRoot)
    if (inflight) {
      await inflight
      return {
        deduped: this.entries.has(canonicalRoot),
        registered: this.entries.has(canonicalRoot),
      }
    }

    const registration = this.performRegister(canonicalRoot)
    this.inFlightRegistrations.set(canonicalRoot, registration)
    try {
      return await registration
    } finally {
      this.inFlightRegistrations.delete(canonicalRoot)
    }
  }

  private async performRegister(canonicalRoot: string): Promise<RegistrationResult> {
    const repo = await this.resolveSlug(canonicalRoot)
    if (!repo) return { deduped: false, registered: false }

    const entry: SyncEntry = {
      repo,
      cwd: canonicalRoot,
      lastSyncAt: null,
      lastResult: null,
      syncing: false,
      timer: null,
    }
    this.entries.set(canonicalRoot, entry)
    this.scheduleSync(canonicalRoot)

    // Fork workflow: also register the upstream repo for issue/label/milestone sync
    const fork = await this.resolveFork(canonicalRoot)
    if (fork && fork.upstreamSlug !== repo) {
      const upstreamKey = `${canonicalRoot}::upstream`
      if (!this.entries.has(upstreamKey)) {
        const upstreamEntry: SyncEntry = {
          repo: fork.upstreamSlug,
          cwd: canonicalRoot,
          lastSyncAt: null,
          lastResult: null,
          syncing: false,
          timer: null,
        }
        this.entries.set(upstreamKey, upstreamEntry)
        this.scheduleSync(upstreamKey)
      }
    }

    return { deduped: false, registered: true }
  }

  /**
   * Re-register all repos previously synced by reading the `cwd` cursor written
   * by `syncUpstreamState`. Called on daemon startup so background sync resumes
   * for every repo in the issue store without waiting for a dispatch to arrive.
   */
  async restoreKnownRepos(): Promise<void> {
    const store = this.store ?? getIssueStore()
    const known = store.listKnownRepoCwds()
    await Promise.all(
      known.map(async ({ repo, cwd }) => {
        const result = await this.register(cwd)
        if (!result.registered) store.deleteSyncCursor(repo, "cwd")
      })
    )
  }

  /** Trigger an immediate sync for a project. Accepts any cwd inside it. */
  async syncNow(cwd: string): Promise<UpstreamSyncResult | null> {
    const canonicalRoot = await resolveProjectRoot(cwd)
    const entry = this.entries.get(canonicalRoot)
    if (!entry) return null
    return this.doSync(canonicalRoot, entry)
  }

  listActive(): UpstreamSyncStatus[] {
    return [...this.entries.values()].map((entry) => toSyncStatus(entry))
  }

  /**
   * Map any cwd inside a registered project back to the root its entries are
   * keyed on. Sync — one realpath, no `.git` walk — so hot callers such as the
   * status-line staleness read stay cheap.
   */
  findEntryRoot(cwd: string): string | null {
    const canonical = canonicalizePath(cwd)
    if (this.entries.has(canonical)) return canonical
    for (const entry of this.entries.values()) {
      if (isPathWithinRoot(canonical, entry.cwd)) return entry.cwd
    }
    return null
  }

  /**
   * Status of the sync entry owning `cwd`, for any cwd inside the project.
   * Callers used to match with `listActive().find((e) => e.cwd === cwd)`, which
   * missed on any string variation and reported the absence as "no staleness
   * data" — indistinguishable from healthy sync (#717).
   */
  findActiveForCwd(cwd: string): UpstreamSyncStatus | null {
    const root = this.findEntryRoot(cwd)
    if (!root) return null
    const entry = this.entries.get(root)
    return entry ? toSyncStatus(entry) : null
  }

  /** Stop periodic sync timers and remove a project plus its fork-upstream entry. */
  unregister(cwd: string): boolean {
    const canonicalRoot = this.findEntryRoot(cwd)
    if (!canonicalRoot) return false
    let removed = false
    for (const entryKey of [canonicalRoot, `${canonicalRoot}::upstream`]) {
      const inflight = this.inFlightSyncs.get(entryKey)
      if (inflight) {
        inflight.controller.abort(new Error("unregistered"))
      }
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
    for (const inflight of this.inFlightSyncs.values()) {
      inflight.controller.abort(new Error("registry closed"))
    }
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
  private inFlightSyncs = new Map<
    string,
    { promise: Promise<UpstreamSyncResult>; controller: AbortController }
  >()

  private async doSync(entryKey: string, entry: SyncEntry): Promise<UpstreamSyncResult> {
    // Join existing in-flight computation rather than firing a duplicate gh call.
    const inflight = this.inFlightSyncs.get(entryKey)
    if (inflight) return inflight.promise

    const controller = new AbortController()
    const computation = this.runSync(entry, controller.signal)
    const record = { promise: computation, controller }
    this.inFlightSyncs.set(entryKey, record)
    void computation.finally(() => {
      if (this.inFlightSyncs.get(entryKey) === record) {
        this.inFlightSyncs.delete(entryKey)
      }
    })
    return this.waitForSync(entry, computation, controller)
  }

  private async waitForSync(
    entry: SyncEntry,
    computation: Promise<UpstreamSyncResult>,
    controller: AbortController
  ): Promise<UpstreamSyncResult> {
    let timeout: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        computation,
        new Promise<UpstreamSyncResult>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort(new Error("sync timeout"))
            reject(new Error("sync timeout"))
          }, this.timeoutMs)
        }),
      ])
    } catch (err) {
      debugLog(`[swiz] UPSTREAM_SYNC_ERROR repo=${entry.repo} ${messageFromUnknownError(err)}`)
      return entry.lastResult ?? createEmptySyncResult()
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private async runSync(entry: SyncEntry, signal?: AbortSignal): Promise<UpstreamSyncResult> {
    entry.syncing = true
    try {
      const store = this.store ?? undefined
      if (signal?.aborted) return fallbackResult(entry)
      const result = await this.sync(entry.repo, entry.cwd, { store, signal })
      if (signal?.aborted) return fallbackResult(entry)
      if (result.fetchOk) entry.lastSyncAt = Date.now()
      entry.lastResult = result
      logSyncSummary(entry.repo, result)
      await replayPendingMutationsIfAny(entry.repo, entry.cwd, store ?? getIssueStore(), signal)
      return result
    } catch (err) {
      debugLog(`[swiz] UPSTREAM_SYNC_ERROR repo=${entry.repo} ${messageFromUnknownError(err)}`)
      return fallbackResult(entry)
    } finally {
      entry.syncing = false
    }
  }
}

function fallbackResult(entry: SyncEntry): UpstreamSyncResult {
  return entry.lastResult ?? createEmptySyncResult()
}

function logSyncSummary(repo: string, result: UpstreamSyncResult): void {
  debugLog(
    `[swiz] UPSTREAM_SYNC repo=${repo} issues=${result.issues.upserted} prs=${result.pullRequests.upserted} ci=${result.ciStatuses.upserted} labels=${result.labels.upserted} milestones=${result.milestones.upserted} branchCi=${result.branchCi.upserted} prBranchDetail=${result.prBranchDetail.upserted} removed_issues=${result.issues.removed} removed_prs=${result.pullRequests.removed}`
  )
}

async function replayPendingMutationsIfAny(
  repo: string,
  cwd: string,
  store: IssueStore,
  signal?: AbortSignal
): Promise<void> {
  const pending = store.pendingCount(repo)
  if (pending > 0 && !signal?.aborted) {
    debugLog(`[swiz] UPSTREAM_SYNC replaying ${pending} pending mutations for ${repo}`)
    await replayPendingMutations(repo, cwd, store, 5, { signal })
  }
}

function createEmptySyncResult(): UpstreamSyncResult {
  const emptyBucket = () => ({ upserted: 0, removed: 0, skipped: 0, changes: [] })
  const emptyTracked = () => ({ upserted: 0, changes: [] })
  return {
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
}

export async function resolveUpstreamRepoSlug(
  cwd: string,
  resolveCapability: RepositoryCapabilityResolver = resolveRepositoryCapability
): Promise<string | null> {
  const capability = await resolveCapability(cwd)
  if (!capability.hasGhCli || !capability.isRepo) return null
  return capability.repoSlug
}

const defaultResolveSlug = resolveUpstreamRepoSlug

async function defaultResolveFork(cwd: string): Promise<{ upstreamSlug: string } | null> {
  const { detectForkTopology } = await import("../../git-helpers.ts")
  return detectForkTopology(cwd)
}
