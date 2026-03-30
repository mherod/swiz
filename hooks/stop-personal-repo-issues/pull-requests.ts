import { orderBy, uniqBy } from "lodash-es"
import { getIssueStore } from "../../src/issue-store.ts"
import { getRepoSlug, ghJson } from "../../src/utils/hook-utils.ts"
import { REBASE_SUGGESTIONS_PER_SIDE } from "./constants.ts"
import type { PR, StopContext } from "./types.ts"

/** Open PRs that should surface in stop messaging (feedback pending or merge conflicts). */
export function openPrNeedsStopAttention(p: PR): boolean {
  return (
    p.reviewDecision === "CHANGES_REQUESTED" ||
    p.reviewDecision === "REVIEW_REQUIRED" ||
    p.mergeable === "CONFLICTING"
  )
}

function getPrCreatedAtMs(pr: PR): number {
  if (!pr.createdAt) return Number.NaN
  return new Date(pr.createdAt).getTime()
}

/**
 * Deterministically order PR candidates by recency.
 * Primary: createdAt (newest first)
 * Fallback: PR number (newest first by monotonic numbering)
 */
export function orderRebaseSuggestionPRs(prs: PR[]): PR[] {
  return orderBy(
    prs,
    [
      (pr) => (Number.isNaN(getPrCreatedAtMs(pr)) ? 0 : 1),
      (pr) => (Number.isNaN(getPrCreatedAtMs(pr)) ? Number.MIN_SAFE_INTEGER : getPrCreatedAtMs(pr)),
      (pr) => pr.number,
    ],
    ["desc", "desc", "desc"]
  )
}

/**
 * Suggest only the oldest and newest conflicting PRs for rebase.
 * GitHub PR numbers are monotonic, so they act as a stable fallback when
 * createdAt is unavailable or invalid in mocks / degraded CLI responses.
 */
export function selectRebaseSuggestionPRs(
  prs: PR[],
  perSide = REBASE_SUGGESTIONS_PER_SIDE
): { shown: PR[]; hiddenCount: number } {
  const ordered = orderRebaseSuggestionPRs(prs)
  if (ordered.length <= perSide * 2) return { shown: ordered, hiddenCount: 0 }

  const newest = ordered.slice(0, perSide)
  const oldest = ordered.slice(-perSide).reverse()
  const shown = uniqBy([...newest, ...oldest], "number")

  return {
    shown,
    hiddenCount: Math.max(0, prs.length - shown.length),
  }
}

export async function getOpenPRsWithFeedback(cwd: string, currentUser: string): Promise<PR[]> {
  const repoSlug = await getRepoSlug(cwd)

  // Store-first: try to read PRs from the IssueStore.
  // Only use cached data if some entries have author info — PRs stored without
  // author (e.g. from older gh CLI fetches that omitted the field) would be
  // silently filtered out, causing the function to return an empty list even
  // when the user has open PRs needing attention.
  if (repoSlug) {
    const store = getIssueStore()
    const cachedPrs = store.listPullRequests<PR & { author?: { login: string } }>(repoSlug)
    const hasAuthorData = cachedPrs.some((pr) => pr.author?.login != null)
    if (hasAuthorData) {
      // Filter locally: authored by or assigned to current user
      const relevant = cachedPrs.filter((pr) => pr.author?.login === currentUser)
      return relevant
    }
  }

  // Fallback: direct gh CLI calls (include author so cached entries support store-first filtering)
  const jsonFields =
    "number,title,url,reviewDecision,mergeable,createdAt,author,closingIssuesReferences"
  const [authoredPrs, reviewerPrs] = await Promise.all([
    ghJson<PR[]>(
      ["pr", "list", "--state", "open", "--author", currentUser, "--json", jsonFields],
      cwd
    ),
    ghJson<PR[]>(
      ["pr", "list", "--state", "open", "--reviewer", currentUser, "--json", jsonFields],
      cwd
    ),
  ])

  // Merge both lists, deduplicating by PR number
  const byNumber = new Map<number, PR>()
  for (const pr of [...(authoredPrs ?? []), ...(reviewerPrs ?? [])]) {
    byNumber.set(pr.number, pr)
  }

  // Cache fetched PRs in the store
  if (repoSlug) {
    const allPrs = [...byNumber.values()]
    if (allPrs.length > 0) {
      getIssueStore().upsertPullRequests(repoSlug, allPrs)
    }
  }

  return [...byNumber.values()]
}

export function partitionPRsForStop(
  allPrs: PR[]
): Pick<StopContext, "changesRequestedPRs" | "reviewRequiredPRs" | "conflictingPRs"> {
  const changesRequestedPRs: PR[] = []
  const reviewRequiredPRs: PR[] = []
  const conflictingPRs: PR[] = []
  for (const p of allPrs.filter(openPrNeedsStopAttention)) {
    if (p.reviewDecision === "CHANGES_REQUESTED") changesRequestedPRs.push(p)
    if (p.reviewDecision === "REVIEW_REQUIRED") reviewRequiredPRs.push(p)
    if (p.mergeable === "CONFLICTING") conflictingPRs.push(p)
  }
  return { changesRequestedPRs, reviewRequiredPRs, conflictingPRs }
}

/** Extract issue numbers covered by open PRs via their closing references. */
export function extractAllOpenPRIssueNumbers(prs: PR[]): Set<number> {
  const issueNumbers = new Set<number>()
  for (const pr of prs) {
    for (const ref of pr.closingIssuesReferences ?? []) {
      issueNumbers.add(ref.number)
    }
  }
  return issueNumbers
}
