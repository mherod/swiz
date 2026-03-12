#!/usr/bin/env bun
// Stop hook: Block stop if current branch has CHANGES_REQUESTED reviews

import { min, uniq } from "lodash-es"
import { getCollaborationModePolicy } from "../src/collaboration-policy.ts"
import { getEffectiveSwizSettings, readProjectSettings, readSwizSettings } from "../src/settings.ts"
import {
  blockStop,
  blockStopHumanRequired,
  getCurrentGitHubUser,
  getDefaultBranch,
  getOpenPrForBranch,
  getRepoNameWithOwner,
  ghJson,
  git,
  hasGhCli,
  isDefaultBranch,
  isGitHubRemote,
  isGitRepo,
  skillAdvice,
} from "./hook-utils.ts"
import { stopHookInputSchema } from "./schemas.ts"

async function main(): Promise<void> {
  const input = stopHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd ?? process.cwd()

  const [globalSettings, projectSettings] = await Promise.all([
    readSwizSettings(),
    readProjectSettings(cwd),
  ])
  const effective = getEffectiveSwizSettings(globalSettings, input.session_id, projectSettings)
  if (!effective.changesRequestedGate) return

  const modePolicy = getCollaborationModePolicy(effective.collaborationMode)
  if (!modePolicy.requirePeerReview) return

  if (!(await isGitRepo(cwd))) return
  if (!hasGhCli()) return
  if (!(await isGitHubRemote(cwd))) return

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return
  const defaultBranch = await getDefaultBranch(cwd)
  if (isDefaultBranch(branch, defaultBranch)) return

  const pr = await getOpenPrForBranch<{
    number: number
    title: string
    author?: { login?: string }
  }>(branch, cwd, "number,title,author")
  if (!pr) return

  const repo = await getRepoNameWithOwner(cwd)
  if (!repo) return
  const currentUser = await getCurrentGitHubUser(cwd)

  type Review = {
    state: string
    user: { login: string }
    body?: string
    submitted_at: string
  }
  type ReviewComment = { user: { login: string }; body: string; created_at: string; path: string }
  type IssueComment = { user: { login: string }; body: string; created_at: string }

  const reviews = await ghJson<Review[]>(["api", `repos/${repo}/pulls/${pr.number}/reviews`], cwd)
  if (!reviews) return

  const changesRequested = reviews.filter((r) => r.state === "CHANGES_REQUESTED")
  if (changesRequested.length === 0) {
    // Distinct queue state: PR exists but no reviewer has responded yet.
    if (reviews.length === 0) {
      const isSelfAuthored =
        Boolean(currentUser) &&
        Boolean(pr.author?.login) &&
        currentUser === (pr.author?.login ?? "")
      if (isSelfAuthored) {
        type PullDetails = {
          requested_reviewers?: Array<{ login: string }>
          requested_teams?: Array<{ slug: string }>
        }
        const pullDetails = await ghJson<PullDetails>(
          ["api", `repos/${repo}/pulls/${pr.number}`],
          cwd
        )
        const hasRequestedReviewer =
          (pullDetails?.requested_reviewers?.length ?? 0) +
            (pullDetails?.requested_teams?.length ?? 0) >
          0
        if (hasRequestedReviewer) return

        const reason =
          `PR #${pr.number} is awaiting first review on a self-authored PR.\n\n` +
          `You cannot request changes on your own PR. An external reviewer must be assigned by a human.\n\n` +
          `Actionable next step:\n` +
          `  gh pr edit ${pr.number} --add-reviewer <github-handle>\n\n` +
          `Current status:\n` +
          `  gh pr view ${pr.number}`
        blockStopHumanRequired(reason)
      }

      const reason =
        `PR #${pr.number} is awaiting first review — no reviewers have responded yet.\n\n` +
        skillAdvice(
          "pr-request-changes",
          "Use the /pr-request-changes skill to submit an actionable review request or wait for reviewer feedback before stopping.",
          [
            `Request review or wait for feedback before stopping:`,
            `  gh pr view ${pr.number}`,
            `  gh pr edit ${pr.number} --add-reviewer <github-handle>`,
            ``,
            `Options:`,
            `  a) Add a reviewer and wait for their response before stopping.`,
            `  b) Self-review: leave a detailed comment summarising the changes and close any open questions.`,
          ].join("\n")
        )
      blockStop(reason, { includeUpdateMemoryAdvice: false })
    }
    return
  }

  // Earliest CHANGES_REQUESTED timestamp — used to collect all comments since
  const earliestTimestamp = min(changesRequested.map((r) => r.submitted_at))!

  // Fetch inline review comments and conversation comments in parallel
  const [reviewComments, issueComments] = await Promise.all([
    ghJson<ReviewComment[]>(["api", `repos/${repo}/pulls/${pr.number}/comments`], cwd),
    ghJson<IssueComment[]>(["api", `repos/${repo}/issues/${pr.number}/comments`], cwd),
  ])

  const subsequentReviewComments = (reviewComments ?? []).filter(
    (c) => c.created_at >= earliestTimestamp
  )
  const subsequentIssueComments = (issueComments ?? []).filter(
    (c) => c.created_at >= earliestTimestamp
  )

  const reviewers = uniq(changesRequested.map((r) => r.user.login)).join(", ")
  const details = changesRequested
    .slice(0, 5)
    .map((r) => `- @${r.user.login}: ${r.body || "No comment provided"}`)
    .join("\n")

  const subsequentLines: string[] = []
  for (const c of subsequentReviewComments.slice(0, 10)) {
    subsequentLines.push(`- @${c.user.login} (${c.path}): ${c.body}`)
  }
  for (const c of subsequentIssueComments.slice(0, 10)) {
    subsequentLines.push(`- @${c.user.login}: ${c.body}`)
  }

  let reason = `PR #${pr.number} has changes requested from reviewers.\n\n`
  reason += `Reviewers: ${reviewers}\n\n`
  reason += `Requested changes:\n${details}\n\n`
  if (subsequentLines.length > 0) {
    reason += `Comments since changes were requested:\n${subsequentLines.join("\n")}\n\n`
  }
  reason += skillAdvice(
    "pr-comments-address",
    "Use the /pr-comments-address skill to address all feedback before stopping.",
    [
      `Address all review feedback before stopping:`,
      `  gh pr view ${pr.number} --comments`,
      ``,
      `For each requested change:`,
      `  1. Read the reviewer's comment carefully`,
      `  2. Make the requested code change`,
      `  3. Reply to the comment confirming the change (or explaining your decision)`,
      `  4. Re-run quality checks: bun run typecheck && bun run lint && bun test`,
      `  5. Push: git push origin $(git branch --show-current)`,
      ``,
      `Once all feedback is addressed, request a re-review:`,
      `  gh pr edit ${pr.number} --add-reviewer <reviewer-handle>`,
    ].join("\n")
  )

  // Review-feedback triage is actionable queue work, not a memory-capture miss.
  blockStop(reason, { includeUpdateMemoryAdvice: false })
}

if (import.meta.main) void main()
