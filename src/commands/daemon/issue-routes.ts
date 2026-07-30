/**
 * Issue/PR dashboard route handlers for the daemon web server.
 * Extracted from web-server.ts (issue #685) to keep routing code focused.
 */
import { getRepoSlug } from "../../git-helpers.ts"
import { getIssueStoreReader } from "../../issue-store.ts"
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
}

function clampDashboardListLimit(raw: number | undefined): number {
  return Math.max(1, Math.min(30, raw ?? 10))
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
  const reader = getIssueStoreReader()
  let prs = await reader.listPullRequests<unknown>(repo)

  const syncing = kickUpstreamSyncWhenEmpty(ctx, projectCwd, prs.length === 0)

  if (prs.length === 0) {
    prs = await reader.listPullRequests<unknown>(repo, STALE_ISSUES_TTL_MS)
  }

  const normalizedPrs = prs
    .map((pr) => normalizeDashboardPr(pr))
    .filter((pr): pr is DashboardPrRecord => pr !== null)
    .toSorted((a, b) => {
      const aMs = a.updatedAt ? Date.parse(a.updatedAt) : 0
      const bMs = b.updatedAt ? Date.parse(b.updatedAt) : 0
      return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0)
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
  const reader = getIssueStoreReader()
  let issues = await reader.listIssues<unknown>(repo)

  const syncing = kickUpstreamSyncWhenEmpty(ctx, projectCwd, issues.length === 0)

  if (issues.length === 0) {
    issues = await reader.listIssues<unknown>(repo, STALE_ISSUES_TTL_MS)
  }

  const normalizedIssues = issues
    .map((issue) => normalizeDashboardIssue(issue))
    .filter((issue): issue is DashboardIssueRecord => issue !== null)
    .toSorted((a, b) => issueUpdatedAtMs(b.updatedAt) - issueUpdatedAtMs(a.updatedAt))
    .slice(0, limit)

  return Response.json({ repo, issues: normalizedIssues, syncing })
}
