/** Canonical PR review and comment summary stored per branch head. */
export interface PrBranchDetail {
  reviewDecision: string
  requestedReviewers: string[]
  commentCount: number
  changesRequestedReviews: Array<{ login: string; body: string }>
  mergeable: string
}

export interface GhPrBranchDetailSource {
  reviewDecision?: string
  requestedReviewers?: Array<{ login?: string }>
  comments?: object[]
  reviews?: Array<{
    state?: string
    author?: { login?: string }
    body?: string
  }>
  mergeable?: string
}

export interface SyncedPrBranchDetailSource {
  reviewDecision?: string
  requestedReviewers?: Array<{ login?: string }>
  mergeable?: string
}

export interface SyncedPrBranchReviewSource {
  state?: string
  user?: { login?: string }
  body?: string
}

function requestedReviewerLogins(reviewers: Array<{ login?: string }> | undefined): string[] {
  return (reviewers ?? [])
    .map((reviewer) => reviewer.login)
    .filter((login): login is string => typeof login === "string" && login.length > 0)
}

function changesRequestedReviews(
  reviews: Array<{ state?: string; login?: string; body?: string }>
): PrBranchDetail["changesRequestedReviews"] {
  return reviews
    .filter((review) => review.state === "CHANGES_REQUESTED")
    .map((review) => ({ login: review.login ?? "", body: review.body?.slice(0, 500) ?? "" }))
    .filter((review) => review.login.length > 0)
}

/** Map the `gh pr view` response used by the daemon-backed reader. */
export function mapGhPrBranchDetail(source: GhPrBranchDetailSource): PrBranchDetail {
  return {
    reviewDecision: source.reviewDecision ?? "",
    requestedReviewers: requestedReviewerLogins(source.requestedReviewers),
    commentCount: Array.isArray(source.comments) ? source.comments.length : 0,
    changesRequestedReviews: changesRequestedReviews(
      (source.reviews ?? []).map((review) => ({
        state: review.state,
        login: review.author?.login,
        body: review.body,
      }))
    ),
    mergeable: source.mergeable ?? "UNKNOWN",
  }
}

/** Map the PR, comments, and reviews fetched by the SQLite sync path. */
export function mapSyncedPrBranchDetail(
  source: SyncedPrBranchDetailSource,
  comments: object[] | null,
  reviews: SyncedPrBranchReviewSource[] | null
): PrBranchDetail {
  return {
    reviewDecision: source.reviewDecision ?? "",
    requestedReviewers: requestedReviewerLogins(source.requestedReviewers),
    commentCount: comments?.length ?? 0,
    changesRequestedReviews: changesRequestedReviews(
      (reviews ?? []).map((review) => ({
        state: review.state,
        login: review.user?.login,
        body: review.body,
      }))
    ),
    mergeable: source.mergeable ?? "UNKNOWN",
  }
}
