#!/usr/bin/env bun

/**
 * PreToolUse hook: Block switching away from a branch that has an open PR
 * with CHANGES_REQUESTED reviews.
 *
 * Dual-mode: SwizToolHook + runSwizHookAsMain.
 */

import { runSwizHookAsMain, type SwizHookOutput, type SwizToolHook } from "../src/SwizHook.ts"
import { shellHookInputSchema } from "../src/schemas.ts"
import { getDefaultBranch, isDefaultBranch } from "../src/utils/git-utils.ts"
import {
  detectForkTopology,
  type ForkTopology,
  forkPushCmd,
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
  preToolUseAllow,
  preToolUseDeny,
  skillAdvice,
} from "../src/utils/hook-utils.ts"

type Review = {
  state: string
  user: { login: string }
  body?: string
}

function isValidShellCommand(input: Record<string, any>): boolean {
  if (!isShellTool((input?.tool_name as string) ?? "")) return false
  const command: string = ((input?.tool_input as Record<string, any>)?.command as string) ?? ""
  return GIT_CHECKOUT_RE.test(command) || GIT_SWITCH_RE.test(command)
}

async function isValidEnvironment(cwd: string): Promise<boolean> {
  return (await isGitRepo(cwd)) && (await isGitHubRemote(cwd)) && hasGhCli()
}

async function validateInputs(input: Record<string, any>, cwd: string): Promise<boolean> {
  if (!isValidShellCommand(input)) return false
  return await isValidEnvironment(cwd)
}

async function getBranchAndPr(
  cwd: string
): Promise<{ branch: string; pr: { number: number; title: string } } | null> {
  const currentBranch = (await git(["branch", "--show-current"], cwd)).trim()
  if (!currentBranch) return null
  const defaultBranch = await getDefaultBranch(cwd)
  if (isDefaultBranch(currentBranch, defaultBranch)) return null
  const pr = await getOpenPrForBranch<{ number: number; title: string }>(
    currentBranch,
    cwd,
    "number,title"
  )
  if (!pr) return null
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

function buildBlockReason(
  pr: { number: number; title: string },
  changesRequested: Review[],
  currentBranch: string,
  fork: ForkTopology | null = null
): string {
  const reviewers = [...new Set(changesRequested.map((r) => r.user.login))].join(", ")
  const details = changesRequested
    .slice(0, 5)
    .map((r) => `- @${r.user.login}: ${r.body || "No comment provided"}`)
    .join("\n")

  return (
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
        `  4. Push: ${forkPushCmd(currentBranch, fork)}`,
        ``,
        `Once all feedback is addressed, request a re-review:`,
        `  gh pr edit ${pr.number} --add-reviewer ${reviewers}`,
      ].join("\n")
    )
  )
}

export async function evaluatePretoolusePrChangesBranchGuard(
  input: unknown
): Promise<SwizHookOutput> {
  const hookInput = shellHookInputSchema.parse(input)
  const cwd: string = hookInput.cwd ?? process.cwd()

  if (!(await validateInputs(hookInput as Record<string, any>, cwd))) return {}

  const branchAndPr = await getBranchAndPr(cwd)
  if (!branchAndPr) return {}

  const { branch: currentBranch, pr } = branchAndPr
  const changesRequested = await getChangesRequestedReviews(pr, cwd)
  if (changesRequested === null) return {}
  if (changesRequested.length === 0) {
    return preToolUseAllow(`PR #${pr.number} has no changes requested — branch switch allowed`)
  }

  const fork = await detectForkTopology(cwd)
  const reason = buildBlockReason(pr, changesRequested, currentBranch, fork)
  return preToolUseDeny(reason)
}

const pretoolusePrChangesBranchGuard: SwizToolHook = {
  name: "pretooluse-pr-changes-branch-guard",
  event: "preToolUse",
  timeout: 10,
  run(input) {
    return evaluatePretoolusePrChangesBranchGuard(input)
  },
}

export default pretoolusePrChangesBranchGuard

if (import.meta.main) {
  await runSwizHookAsMain(pretoolusePrChangesBranchGuard)
}
