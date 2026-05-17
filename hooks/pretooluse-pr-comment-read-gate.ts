#!/usr/bin/env bun

/**
 * PreToolUse hook: Block `gh api .../pulls/N/comments` and `.../pulls/N/reviews`
 * calls unless /pr-comments-address has been recently invoked — but only when on
 * the PR branch (non-default branch with an open PR).
 *
 * Fetching reviewer comments without the comment-address workflow skips structured
 * feedback processing. /pr-comments-address ensures every comment is acknowledged
 * before the agent acts on the review.
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
import { getDefaultBranch, isDefaultBranch } from "../src/utils/git-utils.ts"
import {
  getOpenPrForBranch,
  git,
  hasGhCli,
  isGitHubRemote,
  isGitRepo,
  preToolUseAllow,
  preToolUseDeny,
} from "../src/utils/hook-utils.ts"
import { formatActionPlan } from "../src/utils/inline-hook-helpers.ts"

/** Matches `gh api` reads of PR inline comments or PR reviews. */
const GH_API_PR_COMMENTS_READ_RE = /\bgh\s+api\b[^\n]*\/pulls\/\d+\/(?:comments|reviews)\b/

const pretoolusePrCommentReadGate: SwizToolHook = {
  name: "pretooluse-pr-comment-read-gate",
  event: "preToolUse",
  timeout: 12,

  async run(input: unknown): Promise<SwizHookOutput> {
    const hookInput = shellHookInputSchema.parse(input)
    const cwd = hookInput.cwd ?? process.cwd()

    if (!isShellTool((hookInput.tool_name as string) ?? "")) return {}
    const command = (hookInput.tool_input as Record<string, string>)?.command ?? ""
    if (!GH_API_PR_COMMENTS_READ_RE.test(command)) return {}

    if (!skillExistsForHookPayload("pr-comments-address", hookInput as Record<string, unknown>)) {
      return {}
    }
    if (!(await isGitRepo(cwd)) || !(await isGitHubRemote(cwd)) || !hasGhCli()) return {}

    const branch = (await git(["branch", "--show-current"], cwd)).trim()
    if (!branch) return {}

    const defaultBranch = await getDefaultBranch(cwd)
    if (isDefaultBranch(branch, defaultBranch)) return {}

    const pr = await getOpenPrForBranch<{ number: number }>(branch, cwd, "number")
    if (!pr) return {}

    const recencyOptions = {}
    const recentSkills = await getRecentlyInvokedSkillsForCurrentSession(hookInput, recencyOptions)
    if (recentSkills.includes("pr-comments-address")) {
      return preToolUseAllow(
        `/pr-comments-address was recently invoked — reading PR #${pr.number} comments is permitted.`
      )
    }

    const skillRef = formatSkillReferenceForAgent("pr-comments-address")
    const windowDescription = `Skills used recently (${formatCurrentSessionUsageWindow(recencyOptions)}): ${recentSkills.length === 0 ? "(none)" : recentSkills.map((s) => `/${s}`).join(", ")}`

    return preToolUseDeny(
      `Reading PR #${pr.number} comments requires ${skillRef} to be invoked first.\n\n` +
        `Fetching reviewer comments without the comment-address workflow skips structured ` +
        `feedback processing — ${skillRef} ensures every comment is acknowledged and ` +
        `resolved before acting on the review.\n\n` +
        formatActionPlan([
          `Invoke ${skillRef} to begin the structured comment-address workflow.`,
          `After completing the workflow, PR comment endpoints will be unblocked.`,
        ]) +
        `\n\n${windowDescription}`
    )
  },
}

export default pretoolusePrCommentReadGate

if (import.meta.main) {
  await runSwizHookAsMain(pretoolusePrCommentReadGate)
}
