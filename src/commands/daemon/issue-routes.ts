/**
 * Issue/PR dashboard route handlers for the daemon web server.
 * Extracted from web-server.ts (issue #685) to keep routing code focused.
 */
import { getRepoSlug } from "../../git-helpers.ts"
import { getIssueStoreReader, type IssueStoreReader } from "../../issue-store.ts"
import { type DashboardStoreList, dashboardListLimit } from "../../issue-store-dashboard.ts"
import {
  type DashboardIssueRecord,
  type DashboardPrRecord,
  issueUpdatedAtMs,
  normalizeDashboardIssue,
  normalizeDashboardPr,
  STALE_ISSUES_TTL_MS,
} from "./dashboard-types.ts"
import { registerProjectAndTouch } from "./route-helpers.ts"
import type { UpstreamSyncRegistry } from "./upstream-sync.ts"

export interface IssueRoutesContext {
  touchProject: (cwd: string) => void
  registerProjectWatchers: (cwd: string) => void
  upstreamSyncRegistry: UpstreamSyncRegistry
  issueStoreReader?: IssueStoreReader
}

function clampDashboardListLimit(raw: number | undefined): number {
  return dashboardListLimit(raw ?? 10)
}

async function readDashboardList(
  reader: IssueStoreReader,
  repo: string,
  limit: number,
  kind: "issues" | "prs",
  ttlMs?: number
): Promise<DashboardStoreList<unknown>> {
  if (kind === "issues" && reader.listDashboardIssues)
    return reader.listDashboardIssues(repo, limit, ttlMs)
  if (kind === "prs" && reader.listDashboardPullRequests)
    return reader.listDashboardPullRequests(repo, limit, ttlMs)
  const records =
    kind === "issues"
      ? await reader.listIssues(repo, ttlMs)
      : await reader.listPullRequests(repo, ttlMs)
  return { records, total: records.length }
}

/** Fire-and-forget upstream sync when the store returned no rows; returns whether a sync was scheduled. */
function kickUpstreamSyncWhenEmpty(
  ctx: IssueRoutesContext,
  cwd: string,
  isEmpty: boolean
): boolean {
  if (!isEmpty) return false
  void ctx.upstreamSyncRegistry.register(cwd).then(() => ctx.upstreamSyncRegistry.syncNow(cwd))
  return true
}

export async function handleProjectPrsRoute(
  req: Request,
  ctx: IssueRoutesContext
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    cwd?: string
    limit?: number
  } | null
  const cwd = body?.cwd
  if (typeof cwd !== "string" || !cwd) {
    return Response.json({ error: "Missing required field: cwd (string)" }, { status: 400 })
  }

  const projectCwd = (await registerProjectAndTouch(ctx, cwd)) ?? cwd

  const repo = await getRepoSlug(projectCwd)
  if (!repo) return Response.json({ repo: null, pullRequests: [] satisfies DashboardPrRecord[] })

  const limit = clampDashboardListLimit(body?.limit)
  const reader = ctx.issueStoreReader ?? getIssueStoreReader()
  let prs = await readDashboardList(reader, repo, limit, "prs")

  const syncing = kickUpstreamSyncWhenEmpty(ctx, projectCwd, prs.total === 0)

  if (prs.total === 0) {
    prs = await readDashboardList(reader, repo, limit, "prs", STALE_ISSUES_TTL_MS)
  }

  const normalizedPrs = prs.records
    .map((pr) => normalizeDashboardPr(pr))
    .filter((pr): pr is DashboardPrRecord => pr !== null)
    .toSorted((a, b) => {
      return issueUpdatedAtMs(b.updatedAt) - issueUpdatedAtMs(a.updatedAt) || a.number - b.number
    })
    .slice(0, limit)

  return Response.json({ repo, pullRequests: normalizedPrs, syncing })
}

export async function handleProjectSyncNow(
  req: Request,
  ctx: IssueRoutesContext
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { cwd?: string } | null
  const cwd = body?.cwd
  if (typeof cwd !== "string" || !cwd) {
    return Response.json({ error: "Missing required field: cwd (string)" }, { status: 400 })
  }
  const projectCwd = (await registerProjectAndTouch(ctx, cwd)) ?? cwd
  // Register idempotently, then kick off sync in the background — returns immediately.
  void ctx.upstreamSyncRegistry
    .register(projectCwd)
    .then(() => ctx.upstreamSyncRegistry.syncNow(projectCwd))
  return Response.json({ ok: true, started: true })
}

export async function handleProjectIssuesRoute(
  req: Request,
  ctx: IssueRoutesContext
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    cwd?: string
    limit?: number
  } | null
  const cwd = body?.cwd
  if (typeof cwd !== "string" || !cwd) {
    return Response.json({ error: "Missing required field: cwd (string)" }, { status: 400 })
  }

  const projectCwd = (await registerProjectAndTouch(ctx, cwd)) ?? cwd

  const repo = await getRepoSlug(projectCwd)
  if (!repo) return Response.json({ repo: null, issues: [] satisfies DashboardIssueRecord[] })

  const limit = clampDashboardListLimit(body?.limit)
  const reader = ctx.issueStoreReader ?? getIssueStoreReader()
  let issues = await readDashboardList(reader, repo, limit, "issues")

  const syncing = kickUpstreamSyncWhenEmpty(ctx, projectCwd, issues.total === 0)

  if (issues.total === 0) {
    issues = await readDashboardList(reader, repo, limit, "issues", STALE_ISSUES_TTL_MS)
  }

  const normalizedIssues = issues.records
    .map((issue) => normalizeDashboardIssue(issue))
    .filter((issue): issue is DashboardIssueRecord => issue !== null)
    .toSorted(
      (a, b) => issueUpdatedAtMs(b.updatedAt) - issueUpdatedAtMs(a.updatedAt) || a.number - b.number
    )
    .slice(0, limit)

  return Response.json({ repo, issues: normalizedIssues, syncing })
}
