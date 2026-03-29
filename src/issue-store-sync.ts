import type { GitHubCiRunRecord, GitHubClient, IssueStore } from "./issue-store.ts"

// ─── Upstream sync ─────────────────────────────────────────────────────────

export interface UpstreamSyncResult {
  issues: { upserted: number; removed: number }
  pullRequests: { upserted: number; removed: number }
  ciStatuses: { upserted: number }
  comments: { upserted: number }
  labels: { upserted: number; removed: number }
  milestones: { upserted: number; removed: number }
  branchCi: { upserted: number }
  prBranchDetail: { upserted: number }
  branchProtection: { upserted: number }
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
}

function syncEntityGroup(
  repo: string,
  open: { number: number }[] | null,
  closed: { number: number }[] | null,
  ops: EntitySyncOps,
  bucket: { upserted: number; removed: number }
): void {
  if (open) {
    if (open.length > 0) ops.upsert(repo, open)
    bucket.removed = ops.removeClosed(repo, new Set(open.map((i) => i.number)))
    bucket.upserted = open.length
  }
  if (closed?.length) {
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
  const ciRecords = runs.map((r) => ({
    sha: r.headSha,
    run_id: r.databaseId,
    status: r.status,
    conclusion: r.conclusion,
    url: r.url,
  }))
  s.upsertCiStatuses(repo, ciRecords)
  result.ciStatuses.upserted = ciRecords.length
}

function syncLabels(
  s: IssueStore,
  repo: string,
  labels: { name: string }[] | null,
  result: UpstreamSyncResult
): void {
  if (!labels) return
  if (labels.length > 0) {
    s.upsertLabels(repo, labels)
    result.labels.removed = s.removeStaleLabels(repo, new Set(labels.map((l) => l.name)))
  } else {
    result.labels.removed = s.removeStaleLabels(repo, new Set())
  }
  result.labels.upserted = labels.length
}

function syncMilestones(
  s: IssueStore,
  repo: string,
  milestones: { number: number }[] | null,
  result: UpstreamSyncResult
): void {
  if (!milestones) return
  if (milestones.length > 0) {
    s.upsertMilestones(repo, milestones)
    result.milestones.removed = s.removeStaleMilestones(
      repo,
      new Set(milestones.map((m) => m.number))
    )
  } else {
    result.milestones.removed = s.removeStaleMilestones(repo, new Set())
  }
  result.milestones.upserted = milestones.length
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

/** Upsert fetched branch CI runs into the store. */
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
    s.upsertCiBranchRuns(
      repo,
      branch,
      runs.map((r) => ({
        databaseId: r.databaseId,
        status: r.status,
        conclusion: r.conclusion,
        workflowName: "",
        createdAt: "",
        event: "",
      }))
    )
    result.branchCi.upserted += runs.length
  }
}

/** Upsert fetched branch protection rules into the store. */
function syncBranchProtectionResults(
  ctx: SyncContext,
  branches: string[],
  results: (unknown | null)[]
): void {
  for (let i = 0; i < branches.length; i++) {
    const branch = branches[i]!
    const rules = results[i]
    if (!rules) continue
    ctx.store.upsertBranchProtection(ctx.repo, branch, rules)
    ctx.result.branchProtection.upserted++
  }
}

/** Sync CI runs and PR review detail for branches with open PRs plus the default branch. */
async function syncBranchData(
  ctx: SyncContext,
  prs: { number: number; headRefName?: string }[] | null
): Promise<void> {
  const branches = collectSyncBranches(prs)

  const [branchRunResults, branchProtectionResults] = await Promise.all([
    Promise.all(branches.map((branch) => ctx.client.listBranchWorkflowRuns(ctx.cwd, branch))),
    Promise.all(branches.map((branch) => ctx.client.getBranchProtection(ctx.cwd, branch))),
  ])
  upsertBranchCiRuns(ctx.store, ctx.repo, branches, branchRunResults, ctx.result)
  syncBranchProtectionResults(ctx, branches, branchProtectionResults)

  // Sync PR branch detail for open PRs (reviewDecision, comment count)
  if (!prs) return
  for (const pr of prs) {
    if (!pr.headRefName) continue
    const comments = await ctx.client.listIssueComments(ctx.cwd, pr.number)
    const prData = pr as { reviewDecision?: string }
    ctx.store.upsertPrBranchDetail(ctx.repo, pr.headRefName, {
      reviewDecision: prData.reviewDecision ?? "",
      commentCount: comments?.length ?? 0,
    })
    ctx.result.prBranchDetail.upserted++
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
  issues: { number: number; labels?: unknown; updatedAt?: string }[] | null
): Promise<void> {
  if (!issues) return

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

  const result: UpstreamSyncResult = {
    issues: { upserted: 0, removed: 0 },
    pullRequests: { upserted: 0, removed: 0 },
    ciStatuses: { upserted: 0 },
    comments: { upserted: 0 },
    labels: { upserted: 0, removed: 0 },
    milestones: { upserted: 0, removed: 0 },
    branchCi: { upserted: 0 },
    prBranchDetail: { upserted: 0 },
    branchProtection: { upserted: 0 },
  }

  const [issues, prs, runs, closedIssues, closedPrs, labels, milestones] = await Promise.all([
    gh.listIssues(cwd, "open"),
    gh.listPullRequests(cwd, "open"),
    gh.listWorkflowRuns(cwd),
    // Backfill: fetch recently-closed issues/PRs to explicitly purge stale rows
    gh.listIssues(cwd, "closed"),
    gh.listPullRequests(cwd, "closed"),
    gh.listLabels(cwd),
    gh.listMilestones(cwd),
  ])

  syncEntityGroup(
    repo,
    issues,
    closedIssues,
    {
      upsert: (r, items) => s.upsertIssues(r, items),
      removeClosed: (r, nums) => s.removeClosedIssues(r, nums),
      remove: (r, nums) => s.removeIssues(r, nums),
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
    },
    result.pullRequests
  )
  syncCiRuns(s, repo, runs, result)
  syncLabels(s, repo, labels, result)
  syncMilestones(s, repo, milestones, result)

  const ctx: SyncContext = { store: s, client: gh, repo, cwd, result }

  // ─── Branch-level sync ──────────────────────────────────────────────────
  // Sync CI runs and PR detail for branches with open PRs, plus the default branch.
  await syncBranchData(ctx, prs)

  // ─── Comment sync ───────────────────────────────────────────────────────
  // Sync comments for blocked/stalled issues AND recently-updated issues
  await syncComments(ctx, issues)

  return result
}
