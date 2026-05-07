/**
 * Output formatting for stop-pr-changes-requested blocking messages.
 *
 * Builds contextual blocking messages for changes-requested, no-reviews, and self-authored edge cases.
 */

import type { SwizHookOutput } from "../../src/SwizHook.ts"
import {
  blockStopHumanRequiredObj,
  blockStopObj,
  detectForkTopology,
  forkPushCmd,
  skillAdvice,
} from "../../src/utils/hook-utils.ts"
import type { IssueComment, Review, ReviewComment } from "./types.ts"

export async function buildSelfAuthoredNoReviewerOutput(
  pr: { number: number },
  repo: string,
  cwd: string
): Promise<SwizHookOutput | null> {
  type PullDetails = {
    requested_reviewers?: Array<{ login: string }>
    requested_teams?: Array<{ slug: string }>
  }
  const pullDetails = await import("../../src/utils/hook-utils.ts").then((m) =>
    m.ghJson<PullDetails>(["api", `repos/${repo}/pulls/${pr.number}`], cwd)
  )
  const reviewerCount =
    (pullDetails?.requested_reviewers?.length ?? 0) + (pullDetails?.requested_teams?.length ?? 0)
  if (reviewerCount > 0) return null

  const reason =
    `PR #${pr.number} is awaiting first review on a self-authored PR.\n\n` +
    `You cannot request changes on your own PR. An external reviewer must be assigned by a human.\n\n` +
    `Actionable next step:\n` +
    `  gh pr edit ${pr.number} --add-reviewer <github-handle>\n\n` +
    `Current status:\n` +
    `  gh pr view ${pr.number}`
  return blockStopHumanRequiredObj(reason)
}

export async function buildNoReviewsOutput(
  pr: { number: number; title: string; author?: { login?: string } },
  repo: string,
  cwd: string,
  isSelfAuthored: boolean
): Promise<SwizHookOutput> {
  if (isSelfAuthored) {
    const humanBlock = await buildSelfAuthoredNoReviewerOutput(pr, repo, cwd)
    if (humanBlock) return humanBlock
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
  return blockStopObj(reason)
}

export async function buildChangesRequestedOutput(
  pr: { number: number; title: string },
  changesRequested: Review[],
  reviewComments: ReviewComment[],
  issueComments: IssueComment[],
  cwd: string
): Promise<SwizHookOutput> {
  const { uniq } = await import("lodash-es")
  const reviewers = uniq(changesRequested.map((r) => r.user.login)).join(", ")
  const details = changesRequested
    .slice(0, 5)
    .map((r) => `- @${r.user.login}: ${r.body || "No comment provided"}`)
    .join("\n")

  const subsequentLines: string[] = []
  for (const c of reviewComments.slice(0, 10)) {
    subsequentLines.push(`- @${c.user.login} (${c.path}): ${c.body}`)
  }
  for (const c of issueComments.slice(0, 10)) {
    subsequentLines.push(`- @${c.user.login}: ${c.body}`)
  }

  const fork = await detectForkTopology(cwd)
  let reason = `We should address this PR review: PR #${pr.number} has changes requested from reviewers.\n\n`
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
      `  5. Push: ${forkPushCmd("$(git branch --show-current)", fork)}`,
      ``,
      `Once all feedback is addressed, request a re-review:`,
      `  gh pr edit ${pr.number} --add-reviewer <reviewer-handle>`,
    ].join("\n")
  )

  return blockStopObj(reason)
}
