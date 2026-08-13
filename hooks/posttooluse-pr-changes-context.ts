#!/usr/bin/env bun

/**
 * PostToolUse hook: Inject urgent guidance when switching to a branch that has
 * an open PR with CHANGES_REQUESTED reviews.
 *
 * Fires after git checkout / git switch / gh pr checkout. When the new branch
 * has CHANGES_REQUESTED, injects additionalContext directing the agent to run
 * /pr-comments-address before committing or pushing.
 */

import {
  getOpenPrForBranch,
  ghJsonViaDaemon as ghJson,
  git,
  hasGhCli,
  isDefaultBranch,
  isGitHubRemote,
} from "../src/git-helpers.ts"
import type { PrBranchDetail } from "../src/pr-branch-detail.ts"
import { isGitRepoForHookPayload } from "../src/repository-capability.ts"
import {
  postToolUseAdditionalContext,
  runSwizHookAsMain,
  type SwizHookOutput,
  type SwizShellHook,
} from "../src/SwizHook.ts"
import { type ShellHookInput, shellHookInputSchema } from "../src/schemas.ts"
import { formatSkillReferenceForAgent, skillExistsForHookPayload } from "../src/skill-utils.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import {
  GH_PR_CHECKOUT_RE,
  GIT_CHECKOUT_RE,
  GIT_SWITCH_RE,
  getDefaultBranch,
  getRepoNameWithOwner,
} from "../src/utils/git-utils.ts"

type Review = { state: string; user: { login: string }; body?: string }
type ChangesRequestedReview = { login: string; body?: string }

interface PrCheckoutContext {
  branch: string
  cwd: string
  repo: string
}

function isCheckoutCommand(input: ShellHookInput): boolean {
  if (!input.tool_name || !isShellTool(input.tool_name)) return false
  const command = (input.tool_input?.command as string) ?? ""
  return (
    GIT_CHECKOUT_RE.test(command) || GIT_SWITCH_RE.test(command) || GH_PR_CHECKOUT_RE.test(command)
  )
}

async function resolvePrCheckoutContext(input: ShellHookInput): Promise<PrCheckoutContext | null> {
  const cwd = input.cwd ?? process.cwd()
  if (!(await isGitRepoForHookPayload(input, cwd)) || !(await isGitHubRemote(cwd)) || !hasGhCli()) {
    return null
  }

  const branch = (await git(["branch", "--show-current"], cwd)).trim()
  if (!branch) return null

  const defaultBranch = await getDefaultBranch(cwd)
  if (isDefaultBranch(branch, defaultBranch)) return null

  const repo = await getRepoNameWithOwner(cwd)
  return repo ? { branch, cwd, repo } : null
}

async function getStoredChangesRequested(
  repo: string,
  branch: string
): Promise<ChangesRequestedReview[] | null | undefined> {
  try {
    const { getIssueStoreReader } = await import("../src/issue-store.ts")
    const branchDetail: PrBranchDetail | null = await getIssueStoreReader().getPrBranchDetail(
      repo,
      branch
    )
    if (branchDetail !== null && branchDetail.reviewDecision !== "CHANGES_REQUESTED") return null
    return branchDetail?.changesRequestedReviews
  } catch {
    return undefined
  }
}

async function resolveChangesRequested(
  stored: ChangesRequestedReview[] | null | undefined,
  repo: string,
  prNumber: number,
  cwd: string
): Promise<ChangesRequestedReview[] | null> {
  if (stored !== undefined) return stored

  const reviews = await ghJson<Review[]>(["api", `repos/${repo}/pulls/${prNumber}/reviews`], cwd)
  if (!reviews) return null
  return reviews
    .filter((review) => review.state === "CHANGES_REQUESTED")
    .map((review) => ({ login: review.user.login, body: review.body }))
}

function buildChangesRequestedContext(
  input: ShellHookInput,
  pr: { number: number; title: string },
  changesRequested: ChangesRequestedReview[]
): SwizHookOutput {
  const reviewers = [...new Set(changesRequested.map((review) => review.login))].join(", ")
  const skillInstalled = skillExistsForHookPayload(
    "pr-comments-address",
    input as Record<string, unknown>
  )
  const skillRef = formatSkillReferenceForAgent("pr-comments-address")

  const lines: string[] = [
    `PR #${pr.number} ("${pr.title}") has changes requested by ${reviewers}.`,
    ``,
    `Address all reviewer feedback before committing or pushing to this branch.`,
  ]

  if (skillInstalled) {
    lines.push(``, `Run ${skillRef} to work through each comment systematically.`)
  } else {
    lines.push(``, `Review and address all feedback: gh pr view ${pr.number} --comments`)
  }

  const details = changesRequested
    .slice(0, 3)
    .map(
      (review) =>
        `- @${review.login}: ${review.body ? review.body.slice(0, 200) : "No comment provided"}`
    )
    .join("\n")
  if (details) lines.push(``, `Requested changes:`, details)

  return postToolUseAdditionalContext(lines.join("\n"))
}

const posttoolusPrChangesContext: SwizShellHook = {
  name: "posttooluse-pr-changes-context",
  event: "postToolUse",
  matcher: "Bash",
  timeout: 10,

  async run(input: ShellHookInput): Promise<SwizHookOutput> {
    const parsed = shellHookInputSchema.safeParse(input)
    if (!parsed.success) return {}
    if (!isCheckoutCommand(parsed.data)) return {}

    const context = await resolvePrCheckoutContext(parsed.data)
    if (!context) return {}

    const storedChangesRequested = await getStoredChangesRequested(context.repo, context.branch)
    if (storedChangesRequested === null) return {}

    const pr = await getOpenPrForBranch<{ number: number; title: string }>(
      context.branch,
      context.cwd,
      "number,title"
    )
    if (!pr) return {}

    const changesRequested = await resolveChangesRequested(
      storedChangesRequested,
      context.repo,
      pr.number,
      context.cwd
    )
    if (!changesRequested || changesRequested.length === 0) return {}
    return buildChangesRequestedContext(input, pr, changesRequested)
  },
}

export default posttoolusPrChangesContext

if (import.meta.main) {
  await runSwizHookAsMain(posttoolusPrChangesContext)
}
