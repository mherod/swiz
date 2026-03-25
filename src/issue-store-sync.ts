import type { GitHubClient, IssueStore } from "./issue-store.ts"

// ─── Upstream sync ─────────────────────────────────────────────────────────

export interface UpstreamSyncResult {
  issues: { upserted: number; removed: number }
  pullRequests: { upserted: number; removed: number }
  ciStatuses: { upserted: number }
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

/**
 * Poll upstream GitHub state for a repo and refresh the local store.
 * Fetches open issues, open PRs, and recent workflow runs, then upserts
 * into the shared store. Safe to call on a cadence from the daemon.
 */
export async function syncUpstreamState(
  repo: string,
  cwd: string,
  store?: IssueStore,
  client?: GitHubClient
): Promise<UpstreamSyncResult> {
  const { getIssueStore, GhCliGitHubClient } = await import("./issue-store.ts")
  const s = store ?? getIssueStore()
  const gh = client ?? new GhCliGitHubClient()

  const result: UpstreamSyncResult = {
    issues: { upserted: 0, removed: 0 },
    pullRequests: { upserted: 0, removed: 0 },
    ciStatuses: { upserted: 0 },
  }

  const [issues, prs, runs, closedIssues, closedPrs] = await Promise.all([
    gh.listIssues(cwd, "open"),
    gh.listPullRequests(cwd, "open"),
    gh.listWorkflowRuns(cwd),
    // Backfill: fetch recently-closed issues/PRs to explicitly purge stale rows
    gh.listIssues(cwd, "closed"),
    gh.listPullRequests(cwd, "closed"),
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

  return result
}
