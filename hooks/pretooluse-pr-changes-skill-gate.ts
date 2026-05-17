#!/usr/bin/env bun

/**
 * PreToolUse hook: Block git commit and git push on a branch with open PR
 * CHANGES_REQUESTED reviews until /pr-comments-address has been invoked.
 *
 * When the current branch has an open PR with CHANGES_REQUESTED, the agent
 * must run /pr-comments-address before committing or pushing. This prevents
 * work from being pushed without addressing reviewer feedback.
 */

import { runSwizHookAsMain, type SwizHookOutput, type SwizToolHook } from "../src/SwizHook.ts"
import { shellHookInputSchema } from "../src/schemas.ts"
import {
  formatCurrentSessionUsageWindow,
  formatSkillReferenceForAgent,
  getRecentlyInvokedSkillsForCurrentSession,
  skillExistsForHookPayload,
} from "../src/skill-utils.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import {
  GIT_COMMIT_RE,
  GIT_PUSH_DELETE_RE,
  GIT_PUSH_RE,
  getDefaultBranch,
  isDefaultBranch,
} from "../src/utils/git-utils.ts"
import {
  getOpenPrForBranch,
  getRepoNameWithOwner,
  ghJson,
  git,
  hasGhCli,
  isGitHubRemote,
  isGitRepo,
  preToolUseAllow,
  preToolUseDeny,
} from "../src/utils/hook-utils.ts"
import { formatActionPlan } from "../src/utils/inline-hook-helpers.ts"

type Review = { state: string; user: { login: string }; body?: string }

function classifyCommand(command: string): "commit" | "push" | null {
  if (GIT_COMMIT_RE.test(command)) return "commit"
  if (GIT_PUSH_RE.test(command)) {
    if (GIT_PUSH_DELETE_RE.test(command)) return null
    return "push"
  }
  return null
}

async function getChangesRequestedReviews(
  pr: { number: number },
  repo: string,
  cwd: string
): Promise<Review[] | null> {
  const reviews = await ghJson<Review[]>(["api", `repos/${repo}/pulls/${pr.number}/reviews`], cwd)
  if (!reviews) return null
  return reviews.filter((r) => r.state === "CHANGES_REQUESTED")
}

function buildDenyMessage(
  pr: { number: number; title: string },
  changesRequested: Review[],
  skillRef: string,
  windowDescription: string
): string {
  const reviewers = [...new Set(changesRequested.map((r) => r.user.login))].join(", ")
  const details = changesRequested
    .slice(0, 5)
    .map((r) => `- @${r.user.login}: ${r.body ? r.body.slice(0, 200) : "No comment provided"}`)
    .join("\n")

  return (
    `PR #${pr.number} ("${pr.title}") has changes requested by ${reviewers}. ` +
    `Address all feedback before committing or pushing.\n\n` +
    `Requested changes:\n${details}\n\n` +
    formatActionPlan([
      `Run ${skillRef} to work through each reviewer comment.`,
      `Make all requested changes on this branch.`,
      `Push the updated branch and request a re-review.`,
    ]) +
    `\n\n${windowDescription}`
  )
}

const pretoolusePrChangesSkillGate: SwizToolHook = {
  name: "pretooluse-pr-changes-skill-gate",
  event: "preToolUse",
  timeout: 12,

  async run(input: unknown): Promise<SwizHookOutput> {
    const hookInput = shellHookInputSchema.parse(input)
    const cwd = hookInput.cwd ?? process.cwd()

    if (!isShellTool((hookInput.tool_name as string) ?? "")) return {}
    const command = (hookInput.tool_input as Record<string, string>)?.command ?? ""
    if (!classifyCommand(command)) return {}

    if (!(await isGitRepo(cwd)) || !(await isGitHubRemote(cwd)) || !hasGhCli()) return {}

    const skillInstalled = skillExistsForHookPayload(
      "pr-comments-address",
      hookInput as Record<string, unknown>
    )
    if (!skillInstalled) return {}

    const branch = (await git(["branch", "--show-current"], cwd)).trim()
    if (!branch) return {}

    const defaultBranch = await getDefaultBranch(cwd)
    if (isDefaultBranch(branch, defaultBranch)) return {}

    const repo = await getRepoNameWithOwner(cwd)
    if (!repo) return {}

    // IssueStore fast-path: skip API calls when store confirms no CHANGES_REQUESTED
    try {
      const { getIssueStoreReader } = await import("../src/issue-store.ts")
      const branchDetail = await getIssueStoreReader().getPrBranchDetail<{
        reviewDecision?: string
      }>(repo, branch)
      if (branchDetail !== null && branchDetail.reviewDecision !== "CHANGES_REQUESTED") {
        return preToolUseAllow(
          `No CHANGES_REQUESTED reviews on this branch (cached: ${branchDetail.reviewDecision || "no decision"}).`
        )
      }
    } catch {
      // Store unavailable — fall through to API
    }

    const pr = await getOpenPrForBranch<{ number: number; title: string }>(
      branch,
      cwd,
      "number,title"
    )
    if (!pr) return {}

    const changesRequested = await getChangesRequestedReviews(pr, repo, cwd)
    if (!changesRequested || changesRequested.length === 0) {
      return preToolUseAllow(`No CHANGES_REQUESTED reviews on PR #${pr.number}.`)
    }

    const recencyOptions = {}
    const recentSkills = await getRecentlyInvokedSkillsForCurrentSession(hookInput, recencyOptions)
    if (recentSkills.includes("pr-comments-address")) {
      return preToolUseAllow(`/pr-comments-address was recently invoked — changes addressed.`)
    }

    const skillRef = formatSkillReferenceForAgent("pr-comments-address")
    const windowDescription = `Skills used recently (${formatCurrentSessionUsageWindow(recencyOptions)}): ${recentSkills.length === 0 ? "(none)" : recentSkills.map((s) => `/${s}`).join(", ")}`

    return preToolUseDeny(buildDenyMessage(pr, changesRequested, skillRef, windowDescription))
  },
}

export default pretoolusePrChangesSkillGate

if (import.meta.main) {
  await runSwizHookAsMain(pretoolusePrChangesSkillGate)
}
