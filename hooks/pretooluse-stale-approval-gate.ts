#!/usr/bin/env bun
// PreToolUse hook: Warn before `git commit` would invalidate an existing
// PR approval when branch protection dismisses stale reviews on new commits.
//
// Fires once per 5 minutes (cooldownSeconds: 300 in manifest).
// Fails open on all error paths — missing gh, no PR, no protection, API 404.

import {
  denyPreToolUse,
  formatActionPlan,
  GIT_COMMIT_RE,
  getOpenPrForBranch,
  getRepoSlug,
  ghJson,
  git,
  hasGhCli,
  isDefaultBranch,
  isGitHubRemote,
  isGitRepo,
  isShellTool,
  type ToolHookInput,
} from "./hook-utils.ts"

interface PrWithReviews {
  number: number
  title: string
  baseRefName: string
  reviewDecision: string
  latestReviews: Array<{
    author?: { login?: string }
    state?: string
    submittedAt?: string
    body?: string
  }>
}

interface BranchProtectionReviews {
  dismiss_stale_reviews?: boolean
}

async function main(): Promise<void> {
  const input: ToolHookInput = await Bun.stdin.json()
  if (!isShellTool(input?.tool_name ?? "")) process.exit(0)

  const command = (input?.tool_input?.command as string) ?? ""
  if (!GIT_COMMIT_RE.test(command)) process.exit(0)

  const cwd = input?.cwd ?? ""
  if (!cwd) process.exit(0)

  // Fail open: no git, no gh, not GitHub
  if (!(await isGitRepo(cwd))) process.exit(0)
  if (!hasGhCli()) process.exit(0)
  if (!(await isGitHubRemote(cwd))) process.exit(0)

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch || isDefaultBranch(branch)) process.exit(0)

  // Check for an open approved PR on this branch
  const pr = await getOpenPrForBranch<PrWithReviews>(
    branch,
    cwd,
    "number,title,baseRefName,reviewDecision,latestReviews"
  )
  if (!pr?.number) process.exit(0)

  // Only gate when PR has an approval
  if (pr.reviewDecision !== "APPROVED") process.exit(0)

  const approvals = (pr.latestReviews ?? []).filter((r) => r.state === "APPROVED")
  if (approvals.length === 0) process.exit(0)

  // Check branch protection for dismiss_stale_reviews
  const repo = await getRepoSlug(cwd)
  if (!repo) process.exit(0)

  const protection = await ghJson<BranchProtectionReviews>(
    ["api", `repos/${repo}/branches/${pr.baseRefName}/protection/required_pull_request_reviews`],
    cwd
  )

  // Fail open: no protection or dismiss_stale_reviews not configured
  if (!protection || !protection.dismiss_stale_reviews) process.exit(0)

  // Build denial message
  const approverList = approvals
    .map((a) => {
      const who = a.author?.login ?? "unknown"
      const when = a.submittedAt ?? ""
      const body = a.body
        ? ` — "${a.body.length > 200 ? `${a.body.slice(0, 200)}...` : a.body}"`
        : ""
      return `@${who} (approved ${when})${body}`
    })
    .join("\n  ")

  denyPreToolUse(
    `BLOCKED: This commit would invalidate an existing PR approval.\n\n` +
      `PR #${pr.number}: ${pr.title}\n` +
      `Base branch: ${pr.baseRefName} (dismisses stale reviews on new commits)\n\n` +
      `Current approval(s) that would be lost:\n  ${approverList}\n\n` +
      formatActionPlan([
        "Consider whether this commit is necessary before the current approval is consumed.",
        "If the commit is intentional, retry — this gate has a 5-minute cooldown and will not block again.",
        "Coordinate with the reviewer if re-approval will be needed after this change.",
      ]) +
      `\nThis hook fires once per 5 minutes. After this denial, subsequent commits will proceed.`
  )
}

main().catch(() => process.exit(0))
