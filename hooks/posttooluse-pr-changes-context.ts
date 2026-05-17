#!/usr/bin/env bun

/**
 * PostToolUse hook: Inject urgent guidance when switching to a branch that has
 * an open PR with CHANGES_REQUESTED reviews.
 *
 * Fires after git checkout / git switch / gh pr checkout. When the new branch
 * has CHANGES_REQUESTED, injects additionalContext directing the agent to run
 * /pr-comments-address before committing or pushing.
 */

import { runSwizHookAsMain, type SwizHookOutput, type SwizShellHook } from "../src/SwizHook.ts"
import { type ShellHookInput, shellHookInputSchema } from "../src/schemas.ts"
import { formatSkillReferenceForAgent, skillExistsForHookPayload } from "../src/skill-utils.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { getDefaultBranch, isDefaultBranch } from "../src/utils/git-utils.ts"
import {
  GH_PR_CHECKOUT_RE,
  GIT_CHECKOUT_RE,
  GIT_SWITCH_RE,
  getOpenPrForBranch,
  getRepoNameWithOwner,
  ghJson,
  git,
  hasGhCli,
  isGitHubRemote,
  isGitRepo,
  postToolUseAdditionalContext,
} from "../src/utils/hook-utils.ts"

type Review = { state: string; user: { login: string }; body?: string }

function isCheckoutCommand(input: ShellHookInput): boolean {
  if (!input.tool_name || !isShellTool(input.tool_name)) return false
  const command = (input.tool_input?.command as string) ?? ""
  return (
    GIT_CHECKOUT_RE.test(command) || GIT_SWITCH_RE.test(command) || GH_PR_CHECKOUT_RE.test(command)
  )
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

    const cwd = parsed.data.cwd ?? process.cwd()
    if (!(await isGitRepo(cwd)) || !(await isGitHubRemote(cwd)) || !hasGhCli()) return {}

    const branch = (await git(["branch", "--show-current"], cwd)).trim()
    if (!branch) return {}

    const defaultBranch = await getDefaultBranch(cwd)
    if (isDefaultBranch(branch, defaultBranch)) return {}

    const pr = await getOpenPrForBranch<{ number: number; title: string }>(
      branch,
      cwd,
      "number,title"
    )
    if (!pr) return {}

    const repo = await getRepoNameWithOwner(cwd)
    if (!repo) return {}

    const reviews = await ghJson<Review[]>(["api", `repos/${repo}/pulls/${pr.number}/reviews`], cwd)
    if (!reviews) return {}

    const changesRequested = reviews.filter((r) => r.state === "CHANGES_REQUESTED")
    if (changesRequested.length === 0) return {}

    const reviewers = [...new Set(changesRequested.map((r) => r.user.login))].join(", ")
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
      .map((r) => `- @${r.user.login}: ${r.body ? r.body.slice(0, 200) : "No comment provided"}`)
      .join("\n")
    if (details) {
      lines.push(``, `Requested changes:`, details)
    }

    return postToolUseAdditionalContext(lines.join("\n"))
  },
}

export default posttoolusPrChangesContext

if (import.meta.main) {
  await runSwizHookAsMain(posttoolusPrChangesContext)
}
