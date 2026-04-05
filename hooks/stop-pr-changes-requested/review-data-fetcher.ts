/**
 * Fetcher for review and issue comments related to changes-requested reviews.
 *
 * Retrieves review comments and issue comments created after changes-requested state.
 */

import { min } from "lodash-es"
import { ghJson } from "../../src/utils/hook-utils.ts"
import type { IssueComment, Review, ReviewComment } from "./types.ts"

export async function fetchReviewData(
  repo: string,
  prNumber: number,
  cwd: string,
  changesRequested: Review[]
): Promise<{ reviewComments: ReviewComment[]; issueComments: IssueComment[] }> {
  const earliestTimestamp = min(changesRequested.map((r) => r.submitted_at))!
  const [reviewComments, issueComments] = await Promise.all([
    ghJson<ReviewComment[]>(["api", `repos/${repo}/pulls/${prNumber}/comments`], cwd),
    ghJson<IssueComment[]>(["api", `repos/${repo}/issues/${prNumber}/comments`], cwd),
  ])
  return {
    reviewComments: (reviewComments ?? []).filter((c) => c.created_at >= earliestTimestamp),
    issueComments: (issueComments ?? []).filter((c) => c.created_at >= earliestTimestamp),
  }
}
