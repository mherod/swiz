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

import { GATE_REQUIRED_SKILLS } from "../src/gate-required-skills.ts"
import { getOpenPrForBranch, git, hasGhCli, isGitHubRemote } from "../src/git-helpers.ts"
import { isGitRepoForHookPayload } from "../src/repository-capability.ts"
import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHookOutput,
  type SwizToolHook,
} from "../src/SwizHook.ts"
import { shellHookInputSchema } from "../src/schemas.ts"
import {
  formatCurrentSessionUsageWindow,
  formatSkillReferenceForAgent,
  getRecentlyInvokedSkillsForCurrentSession,
  skillExistsForHookPayload,
} from "../src/skill-utils.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { getDefaultBranch, isDefaultBranch } from "../src/utils/git-utils.ts"
import { formatActionPlan } from "../src/utils/inline-hook-helpers.ts"

/** Matches `gh api` reads of PR inline comments or PR reviews. */
const GH_API_PR_COMMENTS_READ_RE = /\bgh\s+api\b[^\n]*\/pulls\/\d+\/(?:comments|reviews)\b/
const SKILL_NAME = GATE_REQUIRED_SKILLS.prCommentsAddress.name

interface PrCommentReadContext {
  cwd: string
  hookInput: ReturnType<typeof shellHookInputSchema.parse>
}

function getPrCommentReadContext(input: unknown): PrCommentReadContext | null {
  const hookInput = shellHookInputSchema.parse(input)
  if (!isShellTool((hookInput.tool_name as string) ?? "")) return null
  const command = (hookInput.tool_input as Record<string, string>)?.command ?? ""
  if (!GH_API_PR_COMMENTS_READ_RE.test(command)) return null
  if (!skillExistsForHookPayload(SKILL_NAME, hookInput as Record<string, unknown>)) return null
  return { cwd: hookInput.cwd ?? process.cwd(), hookInput }
}

async function findCurrentBranchPr(
  context: PrCommentReadContext
): Promise<{ number: number } | null> {
  if (
    !(await isGitRepoForHookPayload(context.hookInput as Record<string, unknown>, context.cwd)) ||
    !(await isGitHubRemote(context.cwd)) ||
    !hasGhCli()
  ) {
    return null
  }

  const branch = (await git(["branch", "--show-current"], context.cwd)).trim()
  if (!branch) return null
  const defaultBranch = await getDefaultBranch(context.cwd)
  if (isDefaultBranch(branch, defaultBranch)) return null
  return await getOpenPrForBranch<{ number: number }>(branch, context.cwd, "number")
}

const pretoolusePrCommentReadGate: SwizToolHook = {
  name: "pretooluse-pr-comment-read-gate",
  event: "preToolUse",
  timeout: 12,

  async run(input: unknown): Promise<SwizHookOutput> {
    const context = getPrCommentReadContext(input)
    if (!context) return {}
    const pr = await findCurrentBranchPr(context)
    if (!pr) return {}

    const recencyOptions = {}
    const recentSkills = await getRecentlyInvokedSkillsForCurrentSession(
      context.hookInput,
      recencyOptions
    )
    if (recentSkills.includes(SKILL_NAME)) {
      return preToolUseAllow(
        `/pr-comments-address was recently invoked — reading PR #${pr.number} comments is permitted.`
      )
    }

    const skillRef = formatSkillReferenceForAgent(SKILL_NAME)
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
