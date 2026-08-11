#!/usr/bin/env bun

/** Steer Codex away from avoidable guardian reviews before an escalated shell call runs. */

import {
  GIT_ADD_GUARDIAN_DENIAL_LIMIT,
  GIT_ADD_GUARDIAN_DENIAL_MARKER,
  getGuardianReviewContext,
  type SandboxAttemptEvidence,
} from "../src/guardian-review.ts"
import {
  preToolUseAllow,
  preToolUseAllowWithContext,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHookOutput,
  type SwizShellHook,
} from "../src/SwizHook.ts"
import { shellHookInputSchema } from "../src/schemas.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { gitSubcommandRe, stripQuotedShellStrings } from "../src/utils/shell-patterns.ts"

const GIT_ADD_RE = gitSubcommandRe("add\\b")

function avoidanceMessage(evidence: Exclude<SandboxAttemptEvidence, "permission-failed">): string {
  const preamble =
    evidence === "succeeded"
      ? "Guardian review avoided: this command already completed successfully inside the sandbox."
      : evidence === "failed"
        ? "Guardian review avoided: the previous attempt failed, but it did not establish a sandbox restriction."
        : evidence === "unknown"
          ? "Guardian review avoided: the previous result did not prove that sandbox access caused the failure."
          : "Guardian review avoided: this command has not been attempted inside the sandbox yet."

  return [
    preamble,
    "",
    'Retry without `sandbox_permissions: "require_escalated"`.',
    "If that attempt fails with a concrete permission, filesystem, or network restriction, retry only the smallest command that needs escalation and cite that failure in the justification.",
    "Do not escalate merely to suppress an incidental warning after the requested operation already succeeded.",
  ].join("\n")
}

function gitAddAvoidanceMessage(recentDenialCount: number): string {
  const denialNumber = Math.min(recentDenialCount + 1, GIT_ADD_GUARDIAN_DENIAL_LIMIT)
  return [
    `${GIT_ADD_GUARDIAN_DENIAL_MARKER} only needs escalation because the sandbox cannot write Git's index lock.`,
    "",
    `Guardian denial ${denialNumber} of at most ${GIT_ADD_GUARDIAN_DENIAL_LIMIT} in the last minute.`,
    "Retry permitted by guard: you may retry this same narrowly scoped `git add` after this denial.",
    "After three guardian denials in one minute, this guard stands down so the next retry can reach the approval path.",
    "Prefer the non-escalating commit route after checking `git status --short` and `git diff --check`:",
    '  - If every intended file is already tracked, no unrelated tracked changes would be included, and no intended file is untracked, run the normal commit workflow and then `git commit -a -m "<message>"`.',
    "  - `git commit -a` stages tracked modifications and deletions inside the already-approved commit path; the pre-commit hook validates the final index.",
    "  - If any intended file is untracked or unrelated tracked changes exist, do not use `git commit -a`; retry only the same narrowly scoped `git add`.",
  ].join("\n")
}

function gitAddRetryContext(): string {
  return [
    "Guardian retry allowance reached: this narrowly scoped `git add` already received three guardian denials in the last minute.",
    "The retry is permitted now. Keep the escalation limited to this `git add` and preserve the original sandbox index-lock failure in the justification.",
  ].join("\n")
}

export function evaluateGuardianAwareness(input: unknown): SwizHookOutput {
  const parsed = shellHookInputSchema.parse(input)
  if (!isShellTool(parsed.tool_name ?? "")) return preToolUseAllow("")

  const context = getGuardianReviewContext(parsed)
  if (!context) return preToolUseAllow("")

  if (context.priorSandboxAttempt === "permission-failed") {
    const command = stripQuotedShellStrings(parsed.tool_input?.command ?? "")
    if (GIT_ADD_RE.test(command)) {
      if (context.recentGitAddGuardianDenialCount >= GIT_ADD_GUARDIAN_DENIAL_LIMIT) {
        return preToolUseAllowWithContext(
          "Guardian retry allowance reached for this `git add`.",
          gitAddRetryContext(),
          { rephrase: false }
        )
      }
      return preToolUseDeny(gitAddAvoidanceMessage(context.recentGitAddGuardianDenialCount))
    }

    return preToolUseAllowWithContext(
      "Guardian review follows a confirmed sandbox restriction.",
      "A sandboxed attempt failed because of a concrete permission or network restriction. Keep this escalation narrowly scoped to the blocked operation and preserve the failure in the justification."
    )
  }

  return preToolUseDeny(avoidanceMessage(context.priorSandboxAttempt))
}

const pretooluseGuardianAwareness: SwizShellHook = {
  name: "pretooluse-guardian-awareness",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 5,
  run(input) {
    return evaluateGuardianAwareness(input)
  },
}

export default pretooluseGuardianAwareness

if (import.meta.main) await runSwizHookAsMain(pretooluseGuardianAwareness)
