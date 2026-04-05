/**
 * Type definitions for stop-pr-changes-requested hook.
 *
 * Describes PR state, review data, and validation context.
 */

export interface Review {
  state: string
  user: { login: string }
  body?: string
  submitted_at: string
}

export interface IssueComment {
  user: { login: string }
  body: string
  created_at: string
}

export interface ReviewComment extends IssueComment {
  path: string
}

export interface PullDetails {
  requested_reviewers?: Array<{ login: string }>
  requested_teams?: Array<{ slug: string }>
}

export interface PRCheckContext {
  cwd: string
  sessionId: string | undefined
  pr: { number: number; title: string; author?: { login?: string } }
  repo: string
  currentUser: string | null
}

export interface ReviewState {
  reviews: Review[]
  changesRequested: Review[]
  reviewComments: ReviewComment[]
  issueComments: IssueComment[]
  fork: import("../../src/git-helpers.ts").ForkTopology | null
}
