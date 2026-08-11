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

export function evaluateGuardianAwareness(input: unknown): SwizHookOutput {
  const parsed = shellHookInputSchema.parse(input)
  if (!isShellTool(parsed.tool_name ?? "")) return preToolUseAllow("")

  const context = getGuardianReviewContext(parsed)
  if (!context) return preToolUseAllow("")

  if (context.priorSandboxAttempt === "permission-failed") {
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
