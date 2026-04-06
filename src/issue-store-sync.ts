import type { GitHubCiRunRecord, GitHubClient, IssueStore } from "./issue-store.ts"

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
    const oldVal = JSON.stringify(oldObj[field])
    const newVal = JSON.stringify(newObj[field])
    if (oldVal === newVal) continue

    const label = FIELD_LABELS[field] ?? field

    // Numeric delta: "comments +3" or "comments 5 → 2"
    if (
      field === "commentCount" &&
      typeof oldObj[field] === "number" &&
      typeof newObj[field] === "number"
    ) {
      const delta = (newObj[field] as number) - (oldObj[field] as number)
      if (delta > 0) {
        changed.push(`+${delta} ${delta === 1 ? "comment" : "comments"}`)
      } else {
        changed.push(`${label} ${oldObj[field]} → ${newObj[field]}`)
      }
      continue
    }

    // Title: show truncated new value in quotes
    if (field === "title" && typeof newObj[field] === "string") {
      const title = newObj[field] as string
      const truncated = title.length > 50 ? `${title.slice(0, 47)}…` : title
      changed.push(`${label} → "${truncated}"`)
      continue
    }

    // Scalar transition: "state → closed", "review → approved"
    if (typeof newObj[field] === "string") {
      const display =
        field === "reviewDecision"
          ? (REVIEW_LABELS[newObj[field] as string] ?? newObj[field])
          : newObj[field]
      changed.push(`${label} → ${display}`)
      continue
    }

    // Array fields: show added/removed names
    if (field === "labels" || field === "assignees" || field === "requestedReviewers") {
      const diff = describeArrayDiff(oldObj[field], newObj[field])
      if (diff) {
        changed.push(`${label} ${diff}`)
        continue
      }
    }

    changed.push(label)
  }
  if (changed.length > 0) return changed.join(", ")

  // Fall back: count how many top-level keys differ
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)])
  let diffCount = 0
  for (const k of allKeys) {
    if (JSON.stringify(oldObj[k]) !== JSON.stringify(newObj[k])) diffCount++
  }
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
): void {
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
}

function syncCiRuns(
  s: IssueStore,
  repo: string,
  runs:
    | { headSha: string; databaseId: number; status: string; conclusion: string; url: string }[]
    | null,
  result: UpstreamSyncResult
): void {
  if (!runs || runs.length === 0) return
  // Deduplicate by SHA — keep the run with the highest databaseId (most recent).
  // Without this, multiple runs per SHA cause oscillation between syncs.
  const bySha = new Map<string, (typeof runs)[number]>()
  for (const r of runs) {
    const existing = bySha.get(r.headSha)
    if (!existing || r.databaseId > existing.databaseId) bySha.set(r.headSha, r)
  }
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

/** Collect unique branch names: default branch + branches from open PRs. */
function collectSyncBranches(prs: { headRefName?: string }[] | null): string[] {
  const branches = new Set<string>()
  branches.add("main")
  if (prs) {
    for (const pr of prs) {
      if (pr.headRefName) branches.add(pr.headRefName)
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

/** Sync CI runs and PR review detail for branches with open PRs plus the default branch. */
async function syncBranchData(
  ctx: SyncContext,
  prs: { number: number; headRefName?: string }[] | null,
  prsChanged: boolean
): Promise<void> {
  // Always sync the default branch CI and protection (cheap, changes frequently).
  // Only sync PR-specific branches when PRs have changed.
  const branches = prsChanged ? collectSyncBranches(prs) : ["main"] // minimal: just the default branch

  const [branchRunResults, branchProtectionResults] = await Promise.all([
    Promise.all(branches.map((branch) => ctx.client.listBranchWorkflowRuns(ctx.cwd, branch))),
    Promise.all(branches.map((branch) => ctx.client.getBranchProtection(ctx.cwd, branch))),
  ])
  upsertBranchCiRuns(ctx.store, ctx.repo, branches, branchRunResults, ctx.result)
  syncBranchProtectionResults(ctx, branches, branchProtectionResults)

  // Sync PR branch detail only for PRs that actually changed
  if (!prs || !prsChanged) return
  for (const pr of prs) {
    if (!pr.headRefName) continue
    const comments = await ctx.client.listIssueComments(ctx.cwd, pr.number)
    const prData = pr as { reviewDecision?: string; requestedReviewers?: Array<{ login: string }> }
    const reviewerLogins = (prData.requestedReviewers ?? []).map((r) => r.login).filter(Boolean)
    const detail = {
      reviewDecision: prData.reviewDecision ?? "",
      requestedReviewers: reviewerLogins,
      commentCount: comments?.length ?? 0,
    }
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

/**
 * Poll upstream GitHub state for a repo and refresh the local store.
 * Fetches open issues, open PRs, and recent workflow runs, then upserts
 * into the shared store. Safe to call on a cadence from the daemon.
 */
export async function syncUpstreamState(
  repo: string,
  cwd: string,
  opts?: { store?: IssueStore; client?: GitHubClient }
): Promise<UpstreamSyncResult> {
  const { getIssueStore, GhCliGitHubClient } = await import("./issue-store.ts")
  const s = opts?.store ?? getIssueStore()
  const gh = opts?.client ?? new GhCliGitHubClient()

  const bucket = (): SyncBucket => ({ upserted: 0, removed: 0, skipped: 0, changes: [] })
  const tracked = () => ({ upserted: 0, changes: [] as SyncChange[] })
  const result: UpstreamSyncResult = {
    issues: bucket(),
    pullRequests: bucket(),
    ciStatuses: tracked(),
    comments: { upserted: 0 },
    labels: bucket(),
    milestones: bucket(),
    branchCi: tracked(),
    prBranchDetail: tracked(),
    branchProtection: tracked(),
  }

  // ─── Snapshot existing state for fast-path decisions ────────────────────
  const issueSnap = s.getIssueSnapshot(repo)
  const prSnap = s.getPullRequestSnapshot(repo)

  // ─── Fetch open entities (always needed to detect changes) ──────────────
  const [issues, prs, runs, labels, milestones] = await Promise.all([
    gh.listIssues(cwd, "open"),
    gh.listPullRequests(cwd, "open"),
    gh.listWorkflowRuns(cwd),
    gh.listLabels(cwd),
    gh.listMilestones(cwd),
  ])

  // ─── Determine whether closed fetch is needed ──────────────────────────
  // If the open count matches the stored count AND max updatedAt matches,
  // nothing was opened or closed — skip the expensive closed-entity fetch.
  const issueCountChanged = issues ? issues.length !== issueSnap.count : false
  const issueMaxUpdated = issues ? maxUpdatedAt(issues as { updatedAt?: string }[]) : null
  const issuesChanged = issueCountChanged || issueMaxUpdated !== issueSnap.maxUpdatedAt

  const prCountChanged = prs ? prs.length !== prSnap.count : false
  const prMaxUpdated = prs ? maxUpdatedAt(prs as { updatedAt?: string }[]) : null
  const prsChanged = prCountChanged || prMaxUpdated !== prSnap.maxUpdatedAt

  // Only fetch closed entities when open set has changed (count or content)
  const [closedIssues, closedPrs] = await Promise.all([
    issuesChanged ? gh.listIssues(cwd, "closed") : Promise.resolve(null),
    prsChanged ? gh.listPullRequests(cwd, "closed") : Promise.resolve(null),
  ])

  syncEntityGroup(
    repo,
    issues,
    closedIssues,
    {
      upsert: (r, items) => s.upsertIssues(r, items),
      removeClosed: (r, nums) => s.removeClosedIssues(r, nums),
      remove: (r, nums) => s.removeIssues(r, nums),
      getRaw: (r, num) => s.getIssueRaw(r, num),
    },
    result.issues
  )
  syncEntityGroup(
    repo,
    prs,
    closedPrs,
    {
      upsert: (r, items) => s.upsertPullRequests(r, items),
      removeClosed: (r, nums) => s.removeClosedPullRequests(r, nums),
      remove: (r, nums) => s.removePullRequests(r, nums),
      getRaw: (r, num) => s.getPullRequestRaw(r, num),
    },
    result.pullRequests
  )
  syncCiRuns(s, repo, runs, result)
  syncLabels(s, repo, labels, result)
  syncMilestones(s, repo, milestones, result)

  const ctx: SyncContext = { store: s, client: gh, repo, cwd, result }

  // ─── Branch-level sync ──────────────────────────────────────────────────
  // Sync CI runs and PR detail for branches with open PRs, plus the default branch.
  await syncBranchData(ctx, prs, prsChanged)

  // ─── Comment sync ───────────────────────────────────────────────────────
  // Sync comments for blocked/stalled issues AND recently-updated issues
  await syncComments(ctx, issues, issuesChanged)

  return result
}
