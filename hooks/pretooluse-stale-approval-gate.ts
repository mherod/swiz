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
  getDefaultBranch,
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

async function resolveFeatureBranch(cwd: string): Promise<string | null> {
  if (!(await isGitRepo(cwd))) return null
  if (!hasGhCli()) return null
  if (!(await isGitHubRemote(cwd))) return null

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return null
  const defaultBranch = await getDefaultBranch(cwd)
  if (isDefaultBranch(branch, defaultBranch)) return null
  return branch
}

async function findApprovedPr(
  branch: string,
  cwd: string
): Promise<{ pr: PrWithReviews; approvals: PrWithReviews["latestReviews"] } | null> {
  const pr = await getOpenPrForBranch<PrWithReviews>(
    branch,
    cwd,
    "number,title,baseRefName,reviewDecision,latestReviews"
  )
  if (!pr?.number) return null
  if (pr.reviewDecision !== "APPROVED") return null
  const approvals = (pr.latestReviews ?? []).filter((r) => r.state === "APPROVED")
  if (approvals.length === 0) return null
  return { pr, approvals }
}

async function hasDismissStaleReviews(cwd: string, baseRef: string): Promise<boolean> {
  const repo = await getRepoSlug(cwd)
  if (!repo) return false
  const protection = await ghJson<BranchProtectionReviews>(
    ["api", `repos/${repo}/branches/${baseRef}/protection/required_pull_request_reviews`],
    cwd
  )
  return protection?.dismiss_stale_reviews === true
}

function formatApproverList(approvals: PrWithReviews["latestReviews"]): string {
  return approvals
    .map((a) => {
      const who = a.author?.login ?? "unknown"
      const when = a.submittedAt ?? ""
      const body = a.body
        ? ` — "${a.body.length > 200 ? `${a.body.slice(0, 200)}...` : a.body}"`
        : ""
      return `@${who} (approved ${when})${body}`
    })
    .join("\n  ")
}

function buildDenyMessage(
  pr: { number: number; title: string; baseRefName: string },
  approverList: string
): string {
  return (
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

function resolveGitCommitCwd(input: ToolHookInput): string | null {
  if (!isShellTool(input?.tool_name ?? "")) return null
  const command = (input?.tool_input?.command as string) ?? ""
  if (!GIT_COMMIT_RE.test(command)) return null
  const cwd = input?.cwd ?? ""
  return cwd || null
}

async function main(): Promise<void> {
  const input: ToolHookInput = await Bun.stdin.json()
  const cwd = resolveGitCommitCwd(input)
  if (!cwd) process.exit(0)

  const branch = await resolveFeatureBranch(cwd)
  if (!branch) process.exit(0)

  const result = await findApprovedPr(branch, cwd)
  if (!result) process.exit(0)

  if (!(await hasDismissStaleReviews(cwd, result.pr.baseRefName))) process.exit(0)

  const approverList = formatApproverList(result.approvals)
  denyPreToolUse(buildDenyMessage(result.pr, approverList))
}

if (import.meta.main) main().catch(() => process.exit(0))
