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

import {
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
} from "./hook-utils.ts"
import { shellHookInputSchema } from "./schemas.ts"
import { getDefaultBranch, isDefaultBranch } from "./utils/git-utils.ts"

type Review = {
  state: string
  user: { login: string }
  body?: string
}

async function main() {
  const input = shellHookInputSchema.parse(await Bun.stdin.json())
  if (!isShellTool(input?.tool_name ?? "")) process.exit(0)

  const command: string = input?.tool_input?.command ?? ""
  const cwd: string = input.cwd ?? process.cwd()

  // Only intercept branch-switching commands
  if (!GIT_CHECKOUT_RE.test(command) && !GIT_SWITCH_RE.test(command)) process.exit(0)

  // Preflight: git repo, GitHub remote, gh CLI
  if (!(await isGitRepo(cwd))) process.exit(0)
  if (!(await isGitHubRemote(cwd))) process.exit(0)
  if (!hasGhCli()) process.exit(0)

  // Get current branch
  const currentBranch = (await git(["branch", "--show-current"], cwd)).trim()
  if (!currentBranch) process.exit(0) // detached HEAD

  // Skip default branch — no PR to guard
  const defaultBranch = await getDefaultBranch(cwd)
  if (isDefaultBranch(currentBranch, defaultBranch)) process.exit(0)

  // Check for open PR on current branch
  const pr = await getOpenPrForBranch<{ number: number; title: string }>(
    currentBranch,
    cwd,
    "number,title"
  )
  if (!pr) process.exit(0) // no open PR

  // Check review status
  const repo = await getRepoNameWithOwner(cwd)
  if (!repo) process.exit(0)

  const reviews = await ghJson<Review[]>(["api", `repos/${repo}/pulls/${pr.number}/reviews`], cwd)
  if (!reviews) process.exit(0)

  const changesRequested = reviews.filter((r) => r.state === "CHANGES_REQUESTED")
  if (changesRequested.length === 0) process.exit(0) // no changes requested

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
