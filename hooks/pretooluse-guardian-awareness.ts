#!/usr/bin/env bun

/** Steer Codex away from avoidable guardian reviews before an escalated shell call runs. */

import { getGuardianReviewContext, type SandboxAttemptEvidence } from "../src/guardian-review.ts"
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

function gitAddAvoidanceMessage(): string {
  return [
    "Guardian review avoided: this `git add` retry only needs escalation because the sandbox cannot write Git's index lock.",
    "",
    'Do not retry `git add` with `sandbox_permissions: "require_escalated"`.',
    "Use the non-escalating commit route only after checking `git status --short` and `git diff --check`:",
    '  - If every intended file is already tracked, no unrelated tracked changes would be included, and no intended file is untracked, run the normal commit workflow and then `git commit -a -m "<message>"`.',
    "  - `git commit -a` stages tracked modifications and deletions inside the already-approved commit path; the pre-commit hook validates the final index.",
    "  - If any intended file is untracked or unrelated tracked changes exist, do not escalate. Report the sandbox boundary and leave the changes uncommitted.",
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
      return preToolUseDeny(gitAddAvoidanceMessage())
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
