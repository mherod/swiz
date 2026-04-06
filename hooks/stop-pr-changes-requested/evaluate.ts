/**
 * Main orchestration module for stop-pr-changes-requested.
 *
 * Resolves context, fetches reviews, and returns blocking output or empty object.
 */

import type { SwizHookOutput } from "../../src/SwizHook.ts"
import type { StopHookInput } from "../../src/schemas.ts"
import { ghJson } from "../../src/utils/hook-utils.ts"
import { buildChangesRequestedOutput, buildNoReviewsOutput } from "./action-plan.ts"
import { resolvePRCheckContext } from "./context.ts"
import { fetchReviewData } from "./review-data-fetcher.ts"
import { hasChangesRequested, hasNoReviews, isSelfAuthored } from "./review-validators.ts"
import type { Review } from "./types.ts"

/**
 * Evaluate PR review state and return blocking output or empty object.
 * Independent gh/git lookups are parallelized in {@link resolvePRCheckContext}.
 */
export async function evaluateStopPrChangesRequested(
  input: StopHookInput
): Promise<SwizHookOutput> {
  const ctx = await resolvePRCheckContext(input)
  if (!ctx) return {}

  const { cwd, pr, repo, currentUser } = ctx

  // Fetch all reviews for the PR
  const reviews = await ghJson<Review[]>(["api", `repos/${repo}/pulls/${pr.number}/reviews`], cwd)
  if (!reviews) return {}

  // Check for CHANGES_REQUESTED reviews
  const changesRequested = hasChangesRequested(reviews)
  if (changesRequested.length === 0) {
    // No changes requested; check if there are any reviews at all
    if (hasNoReviews(reviews)) {
      return await buildNoReviewsOutput(pr, repo, cwd, isSelfAuthored(pr, currentUser))
    }
    return {}
  }

  // Changes requested; fetch associated comments
  const { reviewComments, issueComments } = await fetchReviewData(
    repo,
    pr.number,
    cwd,
    changesRequested
  )

  return await buildChangesRequestedOutput(pr, changesRequested, reviewComments, issueComments, cwd)
}
