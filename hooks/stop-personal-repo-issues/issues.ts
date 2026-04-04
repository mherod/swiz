import { orderBy } from "lodash-es"
import { normaliseLabel } from "../../src/issue-refinement.ts"
import {
  getDaemonBackedStore,
  getIssueStore,
  getIssueStoreReader,
  replayPendingMutations,
} from "../../src/issue-store.ts"
import { getRepoSlug, ghJson } from "../../src/utils/hook-utils.ts"
import { REVIEWABLE_BLOCK_NORM, SCORE_NORM, SKIP_NORM, TWENTY_FOUR_HOURS_MS } from "./constants.ts"
import type { Issue } from "./types.ts"

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function logHookEvent(event: string, details: string): void {
  console.error(`[swiz][stop-personal-repo-issues] ${event} ${details}`)
}

async function cacheIssuesAndReplayMutations(
  repoSlug: string,
  issues: Issue[],
  cwd: string
): Promise<void> {
  try {
    const store = getIssueStore()
    store.upsertIssues(repoSlug, issues)
    const pending = store.pendingCount(repoSlug)
    if (pending <= 0) return

    const result = await replayPendingMutations(repoSlug, cwd, store)
    const parts: string[] = []
    if (result.replayed > 0) parts.push(`${result.replayed} replayed`)
    if (result.failed > 0) parts.push(`${result.failed} failed`)
    if (result.discarded > 0) parts.push(`${result.discarded} discarded`)
    if (parts.length > 0) {
      logHookEvent("REPLAY_SUMMARY", `repo=${repoSlug} pending=${pending} ${parts.join(", ")}`)
    }
  } catch (err) {
    logHookEvent("REPLAY_INFRA_ERROR", getErrorMessage(err))
  }
}

const FIVE_MINUTES_MS = 5 * 60 * 1000

async function readCachedIssues(repoSlug: string): Promise<Issue[]> {
  try {
    const reader = getIssueStoreReader()
    // Use a 5-minute TTL so daemon-synced data is served from the store.
    // The old ttlMs=0 bypassed the store entirely, forcing every read through
    // the gh CLI fallback chain even when fresh data existed. (#325)
    return await reader.listIssues<Issue>(repoSlug, FIVE_MINUTES_MS)
  } catch {
    return []
  }
}

function filterByUser(issues: Issue[], filterUser?: string): Issue[] {
  return filterUser
    ? issues.filter(
        (i) => i.author?.login === filterUser || i.assignees?.some((a) => a.login === filterUser)
      )
    : issues
}

export function filterVisibleIssues(issues: Issue[], filterUser?: string): Issue[] {
  return filterByUser(issues, filterUser).filter(
    (i) => !(i.labels ?? []).some((l) => SKIP_NORM.has(normaliseLabel(l.name)))
  )
}

/**
 * Returns true if the issue has had recent activity (comment or update) within the last 24 hours.
 * Checks the comment store first (most accurate), then falls back to updatedAt on the issue itself.
 */
function recentlyCommented(issue: Issue, repoSlug: string): boolean {
  // Store-backed check: look for the most recent comment timestamp
  try {
    const store = getIssueStore()
    const latestCommentAt = store.getLatestCommentAt(repoSlug, issue.number)
    if (latestCommentAt !== null) {
      return Date.now() - latestCommentAt < TWENTY_FOUR_HOURS_MS
    }
  } catch {
    // Non-fatal: fall through to updatedAt check
  }
  // Fallback: updatedAt on the issue covers comments too (GitHub updates it on new comments)
  if (!issue.updatedAt) return false
  return Date.now() - new Date(issue.updatedAt).getTime() < TWENTY_FOUR_HOURS_MS
}

/** Issues with reviewable block labels (blocked, upstream, on-hold, waiting). */
export function filterBlockedIssues(
  issues: Issue[],
  repoSlug: string,
  filterUser?: string
): Issue[] {
  const candidates = filterByUser(issues, filterUser).filter((i) =>
    (i.labels ?? []).some((l) => REVIEWABLE_BLOCK_NORM.has(normaliseLabel(l.name)))
  )
  const results: Issue[] = []
  for (const issue of candidates) {
    if (!recentlyCommented(issue, repoSlug)) {
      results.push(issue)
    }
  }
  return results
}

function scoreIssue(issue: Issue): number {
  return (issue.labels ?? []).reduce((sum, l) => sum + (SCORE_NORM[normaliseLabel(l.name)] ?? 0), 0)
}

export function sortIssuesByScoreAndNumber(issues: Issue[]): Issue[] {
  return orderBy(issues, [(issue) => scoreIssue(issue), (issue) => issue.number], ["desc", "desc"])
}

export async function getAllOpenIssues(
  cwd: string
): Promise<{ issues: Issue[]; repoSlug: string | null }> {
  const repoSlug = await getRepoSlug(cwd)
  if (!repoSlug) return { issues: [], repoSlug: null }

  // Store-first: use cached data if fresh
  const cached = await readCachedIssues(repoSlug)
  if (cached.length > 0) return { issues: cached, repoSlug }

  // Daemon-backed store: try daemon HTTP API directly when SQLite is empty
  const daemonIssues = await getDaemonBackedStore().listIssues<Issue>(repoSlug)
  if (daemonIssues.length > 0) {
    try {
      getIssueStore().upsertIssues(repoSlug, daemonIssues)
    } catch {
      // Non-fatal: local cache write failure shouldn't block the hook
    }
    return { issues: daemonIssues, repoSlug }
  }

  // Final fallback: direct gh CLI
  const jsonFields = "number,title,labels,author,assignees,updatedAt"
  const liveIssues = await ghJson<Issue[]>(
    ["issue", "list", "--state", "open", "--json", jsonFields],
    cwd
  )

  if (liveIssues) {
    await cacheIssuesAndReplayMutations(repoSlug, liveIssues, cwd)
  }

  return { issues: liveIssues ?? [], repoSlug }
}

export async function getActionableIssues(cwd: string, filterUser?: string): Promise<Issue[]> {
  const { issues } = await getAllOpenIssues(cwd)
  return filterVisibleIssues(issues, filterUser)
}
