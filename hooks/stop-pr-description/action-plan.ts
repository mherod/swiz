/**
 * Formatting module for PR description validation output.
 *
 * Builds blocking messages when PR description is insufficient.
 */

import type { SwizHookOutput } from "../../src/SwizHook.ts"
import { blockStopObj, skillAdvice } from "../../src/utils/hook-utils.ts"
import type { PRCheckContext, PRValidationState } from "./types.ts"

export function buildPRAdvice(prNumber: number): string {
  return skillAdvice(
    "refine-pr",
    "Use the /refine-pr skill to populate the PR description before stopping.",
    [
      `Update the PR description before stopping:`,
      `  gh pr edit ${prNumber} --body "$(cat <<'EOF'`,
      `## Summary`,
      `<one sentence describing what this PR does>`,
      ``,
      `## Changes`,
      `- <key change 1>`,
      `- <key change 2>`,
      `EOF`,
      `)"`,
    ].join("\n")
  )
}

export function buildEmptyDescriptionOutput(ctx: PRCheckContext): SwizHookOutput {
  const advice = buildPRAdvice(ctx.prNumber)
  return blockStopObj(
    `PR #${ctx.prNumber} ('${ctx.prTitle}') has an empty description.\n\n${advice}`
  )
}

export function buildPlaceholderOutput(ctx: PRCheckContext): SwizHookOutput {
  const advice = buildPRAdvice(ctx.prNumber)
  return blockStopObj(
    `PR #${ctx.prNumber} ('${ctx.prTitle}') still contains template placeholder text.\n\n${advice}`
  )
}

export function buildTooShortOutput(ctx: PRCheckContext, state: PRValidationState): SwizHookOutput {
  const advice = buildPRAdvice(ctx.prNumber)
  const charCount = ctx.prBody.replace(/\s/g, "").length
  return blockStopObj(
    `PR #${ctx.prNumber} ('${ctx.prTitle}') description is too short (${charCount} chars, minimum ${state.minCharCount}).\n\n${advice}`
  )
}
