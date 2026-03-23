#!/usr/bin/env bun

/**
 * PreToolUse hook: Block switching away from a branch that has an open PR
 * with CHANGES_REQUESTED reviews.
 *
 * When a reviewer requests changes on your PR, those changes must be addressed
 * before moving to other work. This hook prevents `git checkout` and
 * `git switch` commands that would leave the branch with unresolved feedback.
 *
 * Policy:
 *   - Only fires on Bash commands matching git checkout/switch
 *   - Only blocks when the current branch has an open PR
 *   - Only blocks when that PR has CHANGES_REQUESTED reviews
 *   - Skips on default branch (no PR to guard)
 *   - Skips when gh CLI is unavailable
 */

import { shellHookInputSchema } from "./schemas.ts"
import { getDefaultBranch, isDefaultBranch } from "./utils/git-utils.ts"
import {
  allowPreToolUse,
  denyPreToolUse,
  GIT_CHECKOUT_RE,
  GIT_SWITCH_RE,
  getOpenPrForBranch,
  getRepoNameWithOwner,
  ghJson,
  git,
  hasGhCli,
  isGitHubRemote,
  isGitRepo,
  isShellTool,
  skillAdvice,
} from "./utils/hook-utils.ts"

type Review = {
  state: string
  user: { login: string }
  body?: string
}

async function validateInputs(input: Record<string, unknown>, cwd: string): Promise<boolean> {
  if (!isShellTool((input?.tool_name as string) ?? "")) return false
  const command: string = ((input?.tool_input as Record<string, unknown>)?.command as string) ?? ""
  if (!GIT_CHECKOUT_RE.test(command) && !GIT_SWITCH_RE.test(command)) return false
  if (!(await isGitRepo(cwd))) return false
  if (!(await isGitHubRemote(cwd))) return false
  if (!hasGhCli()) return false
  return true
}

async function getBranchAndPr(
  cwd: string
): Promise<{ branch: string; pr: { number: number; title: string } } | null> {
  const currentBranch = (await git(["branch", "--show-current"], cwd)).trim()
  if (!currentBranch) return null // detached HEAD
  const defaultBranch = await getDefaultBranch(cwd)
  if (isDefaultBranch(currentBranch, defaultBranch)) return null // no PR on default
  const pr = await getOpenPrForBranch<{ number: number; title: string }>(
    currentBranch,
    cwd,
    "number,title"
  )
  if (!pr) return null // no open PR
  return { branch: currentBranch, pr }
}

async function getChangesRequestedReviews(
  pr: { number: number },
  cwd: string
): Promise<Review[] | null> {
  const repo = await getRepoNameWithOwner(cwd)
  if (!repo) return null
  const reviews = await ghJson<Review[]>(["api", `repos/${repo}/pulls/${pr.number}/reviews`], cwd)
  if (!reviews) return null
  return reviews.filter((r) => r.state === "CHANGES_REQUESTED")
}

async function main() {
  const input = shellHookInputSchema.parse(await Bun.stdin.json())
  const cwd: string = input.cwd ?? process.cwd()

  if (!(await validateInputs(input as Record<string, unknown>, cwd))) process.exit(0)

  const branchAndPr = await getBranchAndPr(cwd)
  if (!branchAndPr) process.exit(0)

  const { branch: currentBranch, pr } = branchAndPr
  const changesRequested = await getChangesRequestedReviews(pr, cwd)
  if (changesRequested === null) process.exit(0)
  if (changesRequested.length === 0) {
    allowPreToolUse(`PR #${pr.number} has no changes requested — branch switch allowed`)
  }

  // Build block message
  const reviewers = [...new Set(changesRequested.map((r) => r.user.login))].join(", ")
  const details = changesRequested
    .slice(0, 5)
    .map((r) => `- @${r.user.login}: ${r.body || "No comment provided"}`)
    .join("\n")

  const reason =
    `PR #${pr.number} ("${pr.title}") has changes requested by ${reviewers}.\n\n` +
    `You cannot switch away from this branch until the requested changes are addressed.\n\n` +
    `Requested changes:\n${details}\n\n` +
    skillAdvice(
      "pr-comments-address",
      "Use the /pr-comments-address skill to address all feedback before switching branches.",
      [
        `Address all review feedback on the current branch:`,
        `  gh pr view ${pr.number} --comments`,
        ``,
        `For each requested change:`,
        `  1. Read the reviewer's comment carefully`,
        `  2. Make the requested code change`,
        `  3. Reply to the comment confirming the change`,
        `  4. Push: git push origin ${currentBranch}`,
        ``,
        `Once all feedback is addressed, request a re-review:`,
        `  gh pr edit ${pr.number} --add-reviewer ${reviewers}`,
      ].join("\n")
    )

  denyPreToolUse(reason)
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Hook error:", e)
    process.exit(1)
  })
}
