/**
 * Review state validators for PR changes-requested detection.
 *
 * Checks for CHANGES_REQUESTED reviews, no reviews, and self-authored edge cases.
 */

import { ghJson } from "../../src/utils/hook-utils.ts"
import type { PullDetails, Review } from "./types.ts"

export function isSelfAuthored(
  pr: { author?: { login?: string } },
  currentUser: string | null
): boolean {
  return (
    Boolean(currentUser) && Boolean(pr.author?.login) && currentUser === (pr.author?.login ?? "")
  )
}

export async function checkSelfAuthoredHasNoReviewer(
  pr: { number: number },
  repo: string,
  cwd: string
): Promise<boolean> {
  const pullDetails = await ghJson<PullDetails>(["api", `repos/${repo}/pulls/${pr.number}`], cwd)
  const reviewerCount =
    (pullDetails?.requested_reviewers?.length ?? 0) + (pullDetails?.requested_teams?.length ?? 0)
  return reviewerCount === 0
}

export function hasChangesRequested(reviews: Review[]): Review[] {
  return reviews.filter((r) => r.state === "CHANGES_REQUESTED")
}

export function hasNoReviews(reviews: Review[]): boolean {
  return reviews.length === 0
}
