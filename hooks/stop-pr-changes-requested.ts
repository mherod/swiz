#!/usr/bin/env bun
// Stop hook: Block stop if current branch has CHANGES_REQUESTED reviews

import {
  blockStop,
  gh,
  git,
  hasGhCli,
  isDefaultBranch,
  isGitHubRemote,
  isGitRepo,
  type StopHookInput,
  skillAdvice,
} from "./hook-utils.ts"

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput
  const cwd = input.cwd

  if (!(await isGitRepo(cwd))) return
  if (!hasGhCli()) return
  if (!(await isGitHubRemote(cwd))) return

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch || isDefaultBranch(branch)) return

  // Find PR for current branch
  const prRaw = await gh(
    ["pr", "list", "--head", branch, "--state", "open", "--json", "number,title"],
    cwd
  )
  if (!prRaw) return

  let prs: Array<{ number: number; title: string }>
  try {
    prs = JSON.parse(prRaw)
  } catch {
    return
  }

  const pr = prs[0]
  if (!pr) return

  // Get repo name
  const repo = await gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd)
  if (!repo) return

  // Get PR reviews (submitted_at needed for timestamp filtering)
  const reviewsRaw = await gh(["api", `repos/${repo}/pulls/${pr.number}/reviews`], cwd)
  if (!reviewsRaw) return

  let reviews: Array<{
    state: string
    user: { login: string }
    body?: string
    submitted_at: string
  }>
  try {
    reviews = JSON.parse(reviewsRaw)
  } catch {
    return
  }

  const changesRequested = reviews.filter((r) => r.state === "CHANGES_REQUESTED")
  if (changesRequested.length === 0) return

  // Earliest CHANGES_REQUESTED timestamp — used to collect all comments since
  const earliestTimestamp = changesRequested.map((r) => r.submitted_at).sort()[0]!

  // Fetch inline review comments and conversation comments in parallel
  const [reviewCommentsRaw, issueCommentsRaw] = await Promise.all([
    gh(["api", `repos/${repo}/pulls/${pr.number}/comments`], cwd),
    gh(["api", `repos/${repo}/issues/${pr.number}/comments`], cwd),
  ])

  type ReviewComment = { user: { login: string }; body: string; created_at: string; path: string }
  type IssueComment = { user: { login: string }; body: string; created_at: string }

  let reviewComments: ReviewComment[] = []
  let issueComments: IssueComment[] = []

  if (reviewCommentsRaw) {
    try {
      reviewComments = JSON.parse(reviewCommentsRaw)
    } catch {
      /* ignore */
    }
  }
  if (issueCommentsRaw) {
    try {
      issueComments = JSON.parse(issueCommentsRaw)
    } catch {
      /* ignore */
    }
  }

  const subsequentReviewComments = reviewComments.filter((c) => c.created_at >= earliestTimestamp)
  const subsequentIssueComments = issueComments.filter((c) => c.created_at >= earliestTimestamp)

  const reviewers = [...new Set(changesRequested.map((r) => r.user.login))].join(", ")
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
    `Address all review feedback before stopping:\n  gh pr view ${pr.number} --comments`
  )

  blockStop(reason)
}

main()
