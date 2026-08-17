import { debugLog } from "./debug.ts"
import { getRepoSlug } from "./git-helpers.ts"
import type {
  GitHubBranchProtectionRecord,
  GitHubCiRunRecord,
  GitHubClient,
  GitHubCommentRecord,
  GitHubIssueRecord,
  GitHubLabelRecord,
  GitHubMilestoneRecord,
  GitHubPullRequestRecord,
  GitHubReviewRecord,
  IssueStore,
} from "./issue-store.ts"
import { runWithLimit } from "./issue-store-replay.ts"
import { mapSyncedPrBranchDetail } from "./pr-branch-detail.ts"
import { getDefaultBranch } from "./utils/git-utils.ts"

// ─── Upstream sync ─────────────────────────────────────────────────────────

/** Human-friendly labels for fields that have domain-specific names. */
const FIELD_LABELS: Record<string, string> = {
  reviewDecision: "review",
  requestedReviewers: "reviewers",
  statusCheckRollup: "checks",
  headRefName: "branch",
  commentCount: "comments",
}

/** Human-friendly CI status labels with icons. */
function formatCiStatus(status: string, conclusion: string): string {
  if (status === "completed") {
    if (conclusion === "success") return "CI ✓ passed"
    if (conclusion === "failure") return "CI ✗ failed"
    if (conclusion === "cancelled") return "CI ⊘ cancelled"
    if (conclusion === "timed_out") return "CI ✗ timed out"
    return `CI ${conclusion || "done"}`
  }
  if (status === "in_progress") return "CI ⏳ in progress"
  if (status === "queued") return "CI ⏳ queued"
  return `${status}/${conclusion}`
}

/** Human-friendly labels for review decision values. */
const REVIEW_LABELS: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes requested",
  REVIEW_REQUIRED: "review required",
}

/** Extract `.name` or `.login` from an array of objects for readable diffs. */
function extractNames(arr: unknown): string[] {
  if (!Array.isArray(arr)) return []
  return arr
    .map((item) => {
      if (typeof item === "string") return item
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>
        return typeof o.name === "string" ? o.name : typeof o.login === "string" ? o.login : null
      }
      return null
    })
    .filter((n): n is string => n !== null)
}

/** Describe a set-difference between two name arrays, e.g. "+bug, -wontfix". */
function describeArrayDiff(oldArr: unknown, newArr: unknown): string | null {
  const oldNames = extractNames(oldArr)
  const newNames = extractNames(newArr)
  if (oldNames.length === 0 && newNames.length === 0) return null
  const oldSet = new Set(oldNames)
  const newSet = new Set(newNames)
  const added = newNames.filter((n) => !oldSet.has(n))
  const removed = oldNames.filter((n) => !newSet.has(n))
  const parts: string[] = []
  if (added.length > 0) parts.push(`+${added.join(", +")}`)
  if (removed.length > 0) parts.push(`-${removed.join(", -")}`)
  return parts.length > 0 ? parts.join(" ") : null
}

/** Fields worth surfacing in change descriptions (order = display priority). */
const DISPLAY_FIELDS = [
  "state",
  "title",
  "labels",
  "assignees",
  "reviewDecision",
  "requestedReviewers",
  "mergeable",
  "statusCheckRollup",
  "commentCount",
  "milestone",
  "description",
  "color",
] as const

function describeNumericDelta(
  field: string,
  label: string,
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>
): string | null {
  if (
    field === "commentCount" &&
    typeof oldObj[field] === "number" &&
    typeof newObj[field] === "number"
  ) {
    const delta = (newObj[field] as number) - (oldObj[field] as number)
    if (delta > 0) {
      return `+${delta} ${delta === 1 ? "comment" : "comments"}`
    }
    return `${label} ${oldObj[field]} → ${newObj[field]}`
  }
  return null
}

function describeScalarFieldChange(field: string, label: string, val: unknown): string | null {
  if (typeof val !== "string") return null
  if (field === "title") {
    const truncated = val.length > 50 ? `${val.slice(0, 47)}…` : val
    return `${label} → "${truncated}"`
  }
  const display = field === "reviewDecision" ? (REVIEW_LABELS[val] ?? val) : val
  return `${label} → ${display}`
}

function describeSingleFieldChange(
  field: string,
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>
): string | null {
  const oldVal = JSON.stringify(oldObj[field])
  const newVal = JSON.stringify(newObj[field])
  if (oldVal === newVal) return null

  const label = FIELD_LABELS[field] ?? field

  const numericDelta = describeNumericDelta(field, label, oldObj, newObj)
  if (numericDelta) return numericDelta

  const scalarChange = describeScalarFieldChange(field, label, newObj[field])
  if (scalarChange) return scalarChange

  if (field === "labels" || field === "assignees" || field === "requestedReviewers") {
    const diff = describeArrayDiff(oldObj[field], newObj[field])
    if (diff) return `${label} ${diff}`
  }

  return label
}

function countChangedKeys(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>
): number {
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)])
  let diffCount = 0
  for (const k of allKeys) {
    if (JSON.stringify(oldObj[k]) !== JSON.stringify(newObj[k])) diffCount++
  }
  return diffCount
}

/**
 * Produce a human-readable summary of what changed between two JSON-serialised
 * entities.  Returns e.g. `"state → closed"`, `"labels +bug"`, `"review → approved"`.
 * Falls back to `"N fields updated"` when the diff is too noisy to summarise.
 */
function describeChanges(oldJson: string, newJson: string): string {
  let oldObj: Record<string, unknown>
  let newObj: Record<string, unknown>
  try {
    oldObj = JSON.parse(oldJson)
    newObj = JSON.parse(newJson)
  } catch {
    return "updated"
  }

  const changed: string[] = []
  for (const field of DISPLAY_FIELDS) {
    const desc = describeSingleFieldChange(field, oldObj, newObj)
    if (desc) changed.push(desc)
  }
  if (changed.length > 0) return changed.join(", ")

  const diffCount = countChangedKeys(oldObj, newObj)
  return diffCount > 0 ? `${diffCount} field${diffCount > 1 ? "s" : ""} updated` : "updated"
}

/** Describes why a single entity was mutated during sync. */
export interface SyncChange {
  kind: "new" | "updated" | "removed"
  /** Entity identifier — issue/PR number, SHA, branch name, or label name. */
  key: string
  /** Human-readable reason for the change. */
  reason: string
}

export interface SyncBucket {
  upserted: number
  removed: number
  skipped: number
  changes: SyncChange[]
}

export interface UpstreamSyncResult {
  issues: SyncBucket
  pullRequests: SyncBucket
  ciStatuses: { upserted: number; changes: SyncChange[] }
  comments: { upserted: number }
  labels: SyncBucket
  milestones: SyncBucket
  branchCi: { upserted: number; changes: SyncChange[] }
  prBranchDetail: { upserted: number; changes: SyncChange[] }
  branchProtection: { upserted: number; changes: SyncChange[] }
  /** Event-sourced sync (#521): rows appended to the issue_events log and the cursor advanced to. */
  events: { inserted: number; cursor: string | null }
  /** REST list-endpoint cache counters for ETag / 304 visibility. */
  restCache: { requests: number; notModified: number; writes: number }
  /**
   * True when the primary list fetches (issues + PRs) succeeded. Freshness
   * cursors and the daemon's `lastSyncAt` only advance when this holds, so a
   * fully-failed sync (offline, expired gh auth) does not report as fresh (#715).
   */
  fetchOk: boolean
}

/** Extract the maximum `updatedAt` ISO string from a list of entities. */
function maxUpdatedAt(items: { updatedAt?: string }[]): string | null {
  let max: string | null = null
  for (const item of items) {
    if (item.updatedAt && (!max || item.updatedAt > max)) max = item.updatedAt
  }
  return max
}

/** Labels that indicate an issue may be blocked/stalled and worth checking for recent comments. */
const COMMENT_SYNC_LABELS = new Set(["blocked", "upstream", "on-hold", "waiting"])

/** How many recently-updated issues (by updatedAt) to sync comments for, beyond label-gated ones. */
const RECENT_ISSUE_COMMENT_LIMIT = 5

/** Shared context for sync helper functions — avoids exceeding max-params. */
interface SyncContext {
  store: IssueStore
  client: GitHubClient
  repo: string
  cwd: string
  result: UpstreamSyncResult
}

interface EntitySyncOps {
  upsert: (repo: string, items: { number: number }[]) => void
  removeClosed: (repo: string, openNumbers: Set<number>) => number
  remove: (repo: string, numbers: number[]) => void
  getRaw: (repo: string, number: number) => string | null
}

/** Shared concurrency cap for raw enrichment requests (branch runs, protection, comments, reviews). */
const RAW_ENRICHMENT_CONCURRENCY = 4

export interface EntitySyncOutcome {
  changedNumbers: Set<number>
}

/**
 * Sync an entity group with change detection. Only upserts entities whose
 * serialized JSON differs from the stored version.
 */
function syncEntityGroup(
  repo: string,
  open: { number: number }[] | null,
  closed: { number: number }[] | null,
  ops: EntitySyncOps,
  bucket: SyncBucket
): EntitySyncOutcome {
  const changedNumbers = new Set<number>()
  if (open) {
    const changed: { number: number }[] = []
    for (const item of open) {
      const newJson = JSON.stringify(item)
      const existingJson = ops.getRaw(repo, item.number)
      if (existingJson === newJson) {
        bucket.skipped++
      } else {
        const isNew = existingJson === null
        changed.push(item)
        changedNumbers.add(item.number)
        bucket.changes.push({
          kind: isNew ? "new" : "updated",
          key: `#${item.number}`,
          reason: isNew ? "new entity" : describeChanges(existingJson, newJson),
        })
      }
    }
    if (changed.length > 0) ops.upsert(repo, changed)
    bucket.removed = ops.removeClosed(repo, new Set(open.map((i) => i.number)))
    bucket.upserted = changed.length
  }
  if (closed?.length) {
    for (const c of closed) {
      bucket.changes.push({ kind: "removed", key: `#${c.number}`, reason: "closed upstream" })
    }
    ops.remove(
      repo,
      closed.map((c) => c.number)
    )
    bucket.removed += closed.length
  }
  return { changedNumbers }
}

type CiRunInput = {
  headSha: string
  databaseId: number
  status: string
  conclusion: string
  url: string
}

function deduplicateRunsBySha(runs: readonly CiRunInput[]): Map<string, CiRunInput> {
  const bySha = new Map<string, CiRunInput>()
  for (const r of runs) {
    const existing = bySha.get(r.headSha)
    if (!existing || r.databaseId > existing.databaseId) bySha.set(r.headSha, r)
  }
  return bySha
}

function syncCiRuns(
  s: IssueStore,
  repo: string,
  runs: CiRunInput[] | null,
  result: UpstreamSyncResult
): void {
  if (!runs || runs.length === 0) return
  const bySha = deduplicateRunsBySha(runs)
  const changed: {
    sha: string
    run_id: number
    status: string
    conclusion: string
    url: string
  }[] = []
  for (const r of bySha.values()) {
    const record = {
      sha: r.headSha,
      run_id: r.databaseId,
      status: r.status,
      conclusion: r.conclusion,
      url: r.url,
    }
    const newJson = JSON.stringify(record)
    const existingJson = s.getCiStatusRaw(repo, record.sha)
    if (existingJson !== newJson) {
      changed.push(record)
      const isNew = existingJson === null
      result.ciStatuses.changes.push({
        kind: isNew ? "new" : "updated",
        key: record.sha.slice(0, 7),
        reason: isNew ? "new run" : formatCiStatus(record.status, record.conclusion),
      })
    }
  }
  if (changed.length > 0) s.upsertCiStatuses(repo, changed)
  result.ciStatuses.upserted = changed.length
}

function syncLabels(
  s: IssueStore,
  repo: string,
  labels: { name: string }[] | null,
  result: UpstreamSyncResult
): void {
  if (!labels) return
  const storedCount = s.getLabelCount(repo)
  if (labels.length > 0) {
    const changed: { name: string }[] = []
    for (const label of labels) {
      const newJson = JSON.stringify(label)
      const existingJson = s.getLabelRaw(repo, label.name)
      if (existingJson !== newJson) {
        changed.push(label)
        result.labels.changes.push({
          kind: existingJson === null ? "new" : "updated",
          key: label.name,
          reason: existingJson === null ? "new label" : describeChanges(existingJson, newJson),
        })
      }
    }
    if (changed.length > 0) s.upsertLabels(repo, changed)
    // Only scan for stale removals when count changed (label added/removed upstream)
    if (labels.length !== storedCount) {
      result.labels.removed = s.removeStaleLabels(repo, new Set(labels.map((l) => l.name)))
    }
    result.labels.upserted = changed.length
    result.labels.skipped = labels.length - changed.length
  } else {
    result.labels.removed = s.removeStaleLabels(repo, new Set())
  }
}

function syncMilestones(
  s: IssueStore,
  repo: string,
  milestones: { number: number }[] | null,
  result: UpstreamSyncResult
): void {
  if (!milestones) return
  const storedCount = s.getMilestoneCount(repo)
  if (milestones.length > 0) {
    const changed: { number: number }[] = []
    for (const milestone of milestones) {
      const newJson = JSON.stringify(milestone)
      const existingJson = s.getMilestoneRaw(repo, milestone.number)
      if (existingJson !== newJson) {
        changed.push(milestone)
        const ms = milestone as { title?: string }
        result.milestones.changes.push({
          kind: existingJson === null ? "new" : "updated",
          key: ms.title ?? `#${milestone.number}`,
          reason: existingJson === null ? "new milestone" : describeChanges(existingJson, newJson),
        })
      }
    }
    if (changed.length > 0) s.upsertMilestones(repo, changed)
    if (milestones.length !== storedCount) {
      result.milestones.removed = s.removeStaleMilestones(
        repo,
        new Set(milestones.map((m) => m.number))
      )
    }
    result.milestones.upserted = changed.length
    result.milestones.skipped = milestones.length - changed.length
  } else {
    result.milestones.removed = s.removeStaleMilestones(repo, new Set())
  }
}

/** Collect unique branch names: default branch + head branches from changed PRs. */
function collectSyncBranches(
  prs: { number: number; headRefName?: string }[] | null,
  changedPrNumbers: Set<number>,
  defaultBranch: string
): string[] {
  const branches = new Set<string>()
  branches.add(defaultBranch)
  if (prs) {
    for (const pr of prs) {
      if (changedPrNumbers.has(pr.number) && pr.headRefName) {
        branches.add(pr.headRefName)
      }
    }
  }
  return [...branches]
}

/** Upsert fetched branch CI runs into the store, skipping unchanged branches. */
function upsertBranchCiRuns(
  s: IssueStore,
  repo: string,
  branches: string[],
  runResults: (GitHubCiRunRecord[] | null)[],
  result: UpstreamSyncResult
): void {
  for (let i = 0; i < branches.length; i++) {
    const branch = branches[i]!
    const runs = runResults[i]
    if (!runs || runs.length === 0) continue
    const mapped = runs
      .map((r) => ({
        databaseId: r.databaseId,
        status: r.status,
        conclusion: r.conclusion,
        workflowName: "",
        createdAt: "",
        event: "",
      }))
      .sort((a, b) => a.databaseId - b.databaseId) // stable ordering for blob comparison
    const newJson = JSON.stringify(mapped)
    const existingJson = s.getCiBranchRunsRaw(repo, branch)
    if (existingJson === newJson) continue
    const isNew = existingJson === null
    s.upsertCiBranchRuns(repo, branch, mapped)
    result.branchCi.upserted += runs.length
    result.branchCi.changes.push({
      kind: isNew ? "new" : "updated",
      key: branch,
      reason: isNew ? `${runs.length} runs` : `${runs.length} runs changed`,
    })
  }
}

/** Upsert fetched branch protection rules into the store, skipping unchanged. */
function syncBranchProtectionResults(
  ctx: SyncContext,
  branches: string[],
  results: (unknown | null)[]
): void {
  for (let i = 0; i < branches.length; i++) {
    const branch = branches[i]!
    const rules = results[i]
    if (!rules) continue
    const newJson = JSON.stringify(rules)
    const existingJson = ctx.store.getBranchProtectionRaw(ctx.repo, branch)
    if (existingJson === newJson) continue
    ctx.store.upsertBranchProtection(ctx.repo, branch, rules)
    ctx.result.branchProtection.upserted++
    ctx.result.branchProtection.changes.push({
      kind: existingJson === null ? "new" : "updated",
      key: branch,
      reason: existingJson === null ? "new rules" : "rules changed",
    })
  }
}

function applyPrBranchDetailResults(
  ctx: SyncContext,
  changedPrs: { number: number; headRefName: string }[],
  prCommentResults: Map<number, GitHubCommentRecord[] | null>,
  prReviewResults: Map<number, GitHubReviewRecord[] | null>
): void {
  for (const pr of changedPrs) {
    const comments = prCommentResults.get(pr.number) ?? null
    const reviews = prReviewResults.get(pr.number) ?? null
    const prData = pr as {
      reviewDecision?: string
      requestedReviewers?: Array<{ login: string }>
      mergeable?: string
    }
    const detail = mapSyncedPrBranchDetail(prData, comments, reviews)
    const newJson = JSON.stringify(detail)
    const existingJson = ctx.store.getPrBranchDetailRaw(ctx.repo, pr.headRefName)
    if (existingJson === newJson) continue
    ctx.store.upsertPrBranchDetail(ctx.repo, pr.headRefName, detail)
    ctx.result.prBranchDetail.upserted++
    ctx.result.prBranchDetail.changes.push({
      kind: existingJson === null ? "new" : "updated",
      key: pr.headRefName,
      reason:
        existingJson === null
          ? `PR #${pr.number}`
          : describeChanges(existingJson, newJson) || "review/comments changed",
    })
  }
}

/** Sync CI runs and PR review detail for branches with open PRs plus the default branch. */
async function syncBranchData(
  ctx: SyncContext,
  prs: { number: number; headRefName?: string }[] | null,
  changedPrNumbers: Set<number>
): Promise<void> {
  // Always sync the default branch CI and protection (cheap, changes frequently).
  // Only sync PR-specific branches when PRs have changed.
  const defaultBranch = await getDefaultBranch(ctx.cwd)
  const branches = collectSyncBranches(prs, changedPrNumbers, defaultBranch)

  const changedPrs = (prs ?? []).filter(
    (pr): pr is { number: number; headRefName: string } =>
      changedPrNumbers.has(pr.number) && Boolean(pr.headRefName)
  )

  const branchRunResults = new Array<GitHubCiRunRecord[] | null>(branches.length)
  const branchProtectionResults = new Array<GitHubBranchProtectionRecord | null>(branches.length)
  const prCommentResults = new Map<number, GitHubCommentRecord[] | null>()
  const prReviewResults = new Map<number, GitHubReviewRecord[] | null>()

  const tasks: (() => Promise<void>)[] = []

  for (let i = 0; i < branches.length; i++) {
    const branch = branches[i]!
    const index = i
    tasks.push(async () => {
      branchRunResults[index] = await ctx.client.listBranchWorkflowRuns(ctx.cwd, branch)
    })
    tasks.push(async () => {
      branchProtectionResults[index] = await ctx.client.getBranchProtection(ctx.cwd, branch)
    })
  }

  for (const pr of changedPrs) {
    tasks.push(async () => {
      const comments = await ctx.client.listIssueComments(ctx.cwd, pr.number)
      prCommentResults.set(pr.number, comments)
    })
    tasks.push(async () => {
      const reviews = await ctx.client.listPullRequestReviews(ctx.cwd, pr.number)
      prReviewResults.set(pr.number, reviews)
    })
  }

  await runWithLimit(RAW_ENRICHMENT_CONCURRENCY, tasks)

  upsertBranchCiRuns(ctx.store, ctx.repo, branches, branchRunResults, ctx.result)
  syncBranchProtectionResults(ctx, branches, branchProtectionResults)
  applyPrBranchDetailResults(ctx, changedPrs, prCommentResults, prReviewResults)
}

/** Identify which issue numbers need comment sync: label-gated + recently-updated. */
function collectCommentSyncTargets(
  issues: { number: number; labels?: unknown; updatedAt?: string }[]
): Set<number> {
  const toSync = new Set<number>()

  for (const issue of issues) {
    const labels = (issue.labels as Array<{ name: string }> | undefined) ?? []
    if (labels.some((l) => COMMENT_SYNC_LABELS.has(l.name.toLowerCase()))) {
      toSync.add(issue.number)
    }
  }

  const sorted = [...issues]
    .filter((i) => i.updatedAt)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
  for (const issue of sorted.slice(0, RECENT_ISSUE_COMMENT_LIMIT)) {
    toSync.add(issue.number)
  }

  return toSync
}

/** Sync comments for blocked/stalled issues AND recently-updated issues. */
async function syncComments(
  ctx: SyncContext,
  issues: { number: number; labels?: unknown; updatedAt?: string }[] | null,
  issuesChanged: boolean
): Promise<void> {
  if (!issues || !issuesChanged) return

  const toSync = collectCommentSyncTargets(issues)
  let commentCount = 0
  for (const issueNumber of toSync) {
    const comments = await ctx.client.listIssueComments(ctx.cwd, issueNumber)
    if (comments && comments.length > 0) {
      ctx.store.upsertIssueComments(ctx.repo, issueNumber, comments)
      commentCount += comments.length
    }
  }
  ctx.result.comments.upserted = commentCount
}

function createInitialSyncResult(): UpstreamSyncResult {
  const bucket = (): SyncBucket => ({ upserted: 0, removed: 0, skipped: 0, changes: [] })
  const tracked = () => ({ upserted: 0, changes: [] as SyncChange[] })
  return {
    issues: bucket(),
    pullRequests: bucket(),
    ciStatuses: tracked(),
    comments: { upserted: 0 },
    labels: bucket(),
    milestones: bucket(),
    branchCi: tracked(),
    prBranchDetail: tracked(),
    branchProtection: tracked(),
    events: { inserted: 0, cursor: null },
    restCache: { requests: 0, notModified: 0, writes: 0 },
    fetchOk: false,
  }
}

async function verifyRepoOriginInvariant(
  repo: string,
  cwd: string,
  hasClient: boolean
): Promise<boolean> {
  if (hasClient) return true
  const originSlug = await getRepoSlug(cwd)
  if (originSlug !== null && originSlug !== repo) {
    debugLog(
      `[issue-sync] refusing sync: repo "${repo}" does not match the origin of cwd ` +
        `("${originSlug}"). cwd-implied fetches would corrupt the cache — run from the ` +
        `repo's checkout or supply a repo-targeted client.`
    )
    return false
  }
  return true
}

function hasEntitySnapshotChanged(
  items: unknown[] | null,
  snap: { count: number; maxUpdatedAt: string | null }
): boolean {
  if (!items) return false
  const countChanged = items.length !== snap.count
  const maxUpdated = maxUpdatedAt(items as { updatedAt?: string }[])
  return countChanged || maxUpdated !== snap.maxUpdatedAt
}

interface PrimarySyncPayloads {
  issues: GitHubIssueRecord[] | null
  prs: GitHubPullRequestRecord[] | null
  runs: CiRunInput[] | null
  labels: { name: string }[] | null
  milestones: { number: number }[] | null
  closedIssues: GitHubIssueRecord[] | null
  closedPrs: GitHubPullRequestRecord[] | null
}

export interface PrimarySyncOutcome {
  changedIssueNumbers: Set<number>
  changedPrNumbers: Set<number>
}

function syncPrimaryEntities(
  s: IssueStore,
  repo: string,
  payloads: PrimarySyncPayloads,
  result: UpstreamSyncResult
): PrimarySyncOutcome {
  const issuesOutcome = syncEntityGroup(
    repo,
    payloads.issues,
    payloads.closedIssues,
    {
      upsert: (r, items) => s.upsertIssues(r, items),
      removeClosed: (r, nums) => s.removeClosedIssues(r, nums),
      remove: (r, nums) => s.removeIssues(r, nums),
      getRaw: (r, num) => s.getIssueRaw(r, num),
    },
    result.issues
  )
  const prsOutcome = syncEntityGroup(
    repo,
    payloads.prs,
    payloads.closedPrs,
    {
      upsert: (r, items) => s.upsertPullRequests(r, items),
      removeClosed: (r, nums) => s.removeClosedPullRequests(r, nums),
      remove: (r, nums) => s.removePullRequests(r, nums),
      getRaw: (r, num) => s.getPullRequestRaw(r, num),
    },
    result.pullRequests
  )
  syncCiRuns(s, repo, payloads.runs, result)
  syncLabels(s, repo, payloads.labels, result)
  syncMilestones(s, repo, payloads.milestones, result)
  return {
    changedIssueNumbers: issuesOutcome.changedNumbers,
    changedPrNumbers: prsOutcome.changedNumbers,
  }
}

function checkAllPrimaryListsCached(
  cacheHits: number,
  payloads: PrimarySyncPayloads,
  issuesChanged: boolean,
  prsChanged: boolean
): boolean {
  return (
    cacheHits >= 5 &&
    payloads.issues !== null &&
    payloads.prs !== null &&
    payloads.runs !== null &&
    payloads.labels !== null &&
    payloads.milestones !== null &&
    !issuesChanged &&
    !prsChanged
  )
}

async function fetchClosedEntities(
  gh: GitHubClient,
  cwd: string,
  issuesChanged: boolean,
  prsChanged: boolean
): Promise<[GitHubIssueRecord[] | null, GitHubPullRequestRecord[] | null]> {
  return await Promise.all([
    issuesChanged ? gh.listIssues(cwd, "closed") : Promise.resolve(null),
    prsChanged ? gh.listPullRequests(cwd, "closed") : Promise.resolve(null),
  ])
}

function updateSyncFreshnessCursor(ctx: SyncContext, isFetchOk: boolean): void {
  ctx.result.fetchOk = isFetchOk
  if (isFetchOk) {
    ctx.store.setSyncCursor(ctx.repo, "last_synced", new Date().toISOString())
  }
}

async function fetchOpenEntities(
  gh: GitHubClient,
  cwd: string
): Promise<
  [
    GitHubIssueRecord[] | null,
    GitHubPullRequestRecord[] | null,
    GitHubCiRunRecord[] | null,
    GitHubLabelRecord[] | null,
    GitHubMilestoneRecord[] | null,
  ]
> {
  return await Promise.all([
    gh.listIssues(cwd, "open"),
    gh.listPullRequests(cwd, "open"),
    gh.listWorkflowRuns(cwd),
    gh.listLabels(cwd),
    gh.listMilestones(cwd),
  ])
}

interface PrimarySyncState {
  payloads: PrimarySyncPayloads
  issuesChanged: boolean
  prsChanged: boolean
  changedPrNumbers: Set<number>
}

async function syncSecondaryEntities(
  ctx: SyncContext,
  primary: PrimarySyncState,
  signal?: AbortSignal
): Promise<void> {
  const allPrimaryListsCached = checkAllPrimaryListsCached(
    ctx.result.restCache.notModified,
    primary.payloads,
    primary.issuesChanged,
    primary.prsChanged
  )
  if (allPrimaryListsCached) return

  await syncBranchData(ctx, primary.payloads.prs, primary.changedPrNumbers)
  if (signal?.aborted) return
  await syncComments(ctx, primary.payloads.issues, primary.issuesChanged)
  if (signal?.aborted) return
  await syncIssueEvents(ctx.store, ctx.client, ctx.repo, ctx.result)
}

async function syncPrimaryData(
  ctx: SyncContext,
  signal?: AbortSignal
): Promise<PrimarySyncState | null> {
  const [issues, prs, runs, labels, milestones] = await fetchOpenEntities(ctx.client, ctx.cwd)
  if (signal?.aborted) return null

  const issueSnap = ctx.store.getIssueSnapshot(ctx.repo)
  const prSnap = ctx.store.getPullRequestSnapshot(ctx.repo)
  const issuesChanged = hasEntitySnapshotChanged(issues, issueSnap)
  const prsChanged = hasEntitySnapshotChanged(prs, prSnap)
  const [closedIssues, closedPrs] = await fetchClosedEntities(
    ctx.client,
    ctx.cwd,
    issuesChanged,
    prsChanged
  )
  if (signal?.aborted) return null

  const payloads: PrimarySyncPayloads = {
    issues,
    prs,
    runs,
    labels,
    milestones,
    closedIssues,
    closedPrs,
  }

  const outcome = syncPrimaryEntities(ctx.store, ctx.repo, payloads, ctx.result)
  return {
    payloads,
    issuesChanged,
    prsChanged,
    changedPrNumbers: outcome.changedPrNumbers,
  }
}

async function resolveSyncSetup(
  repo: string,
  cwd: string,
  opts?: { store?: IssueStore; client?: GitHubClient; signal?: AbortSignal }
): Promise<{ ctx: SyncContext; signal?: AbortSignal } | null> {
  const signal = opts?.signal
  const { getIssueStore, GhCliGitHubClient } = await import("./issue-store.ts")
  const store = opts?.store ?? getIssueStore()
  const result = createInitialSyncResult()
  const client = opts?.client ?? new GhCliGitHubClient(result.restCache, signal)

  const allowed = await verifyRepoOriginInvariant(repo, cwd, Boolean(opts?.client))
  if (!allowed || signal?.aborted) return null

  return { ctx: { store, client, repo, cwd, result }, signal }
}

/**
 * Poll upstream GitHub state for a repo and refresh the local store.
 * Fetches open issues, open PRs, and recent workflow runs, then upserts
 * into the shared store. Safe to call on a cadence from the daemon.
 */
export async function syncUpstreamState(
  repo: string,
  cwd: string,
  opts?: { store?: IssueStore; client?: GitHubClient; signal?: AbortSignal }
): Promise<UpstreamSyncResult> {
  const setup = await resolveSyncSetup(repo, cwd, opts)
  if (!setup) return createInitialSyncResult()

  const { ctx, signal } = setup
  const primary = await syncPrimaryData(ctx, signal)
  if (!primary || signal?.aborted) return ctx.result

  await syncSecondaryEntities(ctx, primary, signal)
  if (signal?.aborted) return ctx.result

  updateSyncFreshnessCursor(ctx, primary.payloads.issues !== null && primary.payloads.prs !== null)
  return ctx.result
}

/**
 * Fetch new issue events via the GitHub REST Events API, append them to the
 * local log idempotently, and advance the per-repo sync cursor to the newest
 * event's `created_at`. A null return from the client (API error, gh failure)
 * leaves the cursor untouched so the next sync retries the same window.
 */
async function syncIssueEvents(
  store: IssueStore,
  gh: GitHubClient,
  repo: string,
  result: UpstreamSyncResult
): Promise<void> {
  const EVENT_CURSOR_KIND = "issue_events"
  const cursor = store.getSyncCursor(repo, EVENT_CURSOR_KIND)
  const events = await gh.listIssueEventsSince(repo, cursor)
  if (!events) return // leave cursor unchanged so next sync retries

  if (events.length === 0) {
    result.events.cursor = cursor
    return
  }

  const inserted = store.appendIssueEvents(repo, events)
  const newCursor = store.getLatestIssueEventTimestamp(repo) ?? cursor
  if (newCursor) store.setSyncCursor(repo, EVENT_CURSOR_KIND, newCursor)

  result.events.inserted = inserted
  result.events.cursor = newCursor
}
