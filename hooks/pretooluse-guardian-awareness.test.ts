import { describe, expect, test } from "bun:test"
import type { GuardianReviewContext } from "../src/guardian-review.ts"
import { getHookSpecificOutput } from "../src/utils/hook-specific-output.ts"
import { evaluateGuardianAwareness } from "./pretooluse-guardian-awareness.ts"

function evaluate(
  priorSandboxAttempt?: GuardianReviewContext["priorSandboxAttempt"],
  command = "git push origin main",
  recentGitAddGuardianDenialCount = 0
) {
  return evaluateGuardianAwareness({
    tool_name: "Bash",
    tool_input: { command },
    ...(priorSandboxAttempt
      ? {
          _guardianReview: {
            requested: true,
            source: "codex-transcript",
            priorSandboxAttempt,
            recentGitAddGuardianDenialCount,
          },
        }
      : {}),
  })
}

describe("pretooluse-guardian-awareness", () => {
  test("allows ordinary sandboxed commands silently", () => {
    const specific = getHookSpecificOutput(evaluate())
    expect(specific?.permissionDecision).toBe("allow")
    expect(specific?.permissionDecisionReason).toBe("")
  })

  test("blocks proactive escalation and requests a sandboxed attempt", () => {
    const output = evaluate("not-attempted")
    const specific = getHookSpecificOutput(output)
    expect(specific?.permissionDecision).toBe("deny")
    expect(specific?.permissionDecisionReason).toContain("has not been attempted")
    expect(specific?.permissionDecisionReason).toContain("Retry without `sandbox_permissions")
  })

  test("blocks escalation after the sandboxed operation already succeeded", () => {
    const specific = getHookSpecificOutput(evaluate("succeeded"))
    expect(specific?.permissionDecision).toBe("deny")
    expect(specific?.permissionDecisionReason).toContain("already completed successfully")
    expect(specific?.permissionDecisionReason).toContain("incidental warning")
  })

  test("allows narrowly scoped escalation after a proven sandbox restriction", () => {
    const specific = getHookSpecificOutput(evaluate("permission-failed"))
    expect(specific?.permissionDecision).toBe("allow")
    expect(specific?.permissionDecisionReason).toContain("confirmed sandbox restriction")
    expect(specific?.additionalContext).toContain("narrowly scoped")
  })

  test("steers sandbox-blocked git add away from escalation", () => {
    const specific = getHookSpecificOutput(
      evaluate("permission-failed", "git add -- src/guardian-review.ts")
    )
    expect(specific?.permissionDecision).toBe("deny")
    expect(specific?.permissionDecisionReason).toContain("Guardian denial 1 of at most 3")
    expect(specific?.permissionDecisionReason).toContain("Retry permitted by guard")
    expect(specific?.permissionDecisionReason).toContain("you may retry")
    expect(specific?.permissionDecisionReason).toContain("git commit -a")
    expect(specific?.permissionDecisionReason).toContain("already tracked")
    expect(specific?.permissionDecisionReason).toContain("untracked")
  })

  test("allows the retry after three recent git add guardian denials", () => {
    const specific = getHookSpecificOutput(
      evaluate("permission-failed", "git add -- src/guardian-review.ts", 3)
    )
    expect(specific?.permissionDecision).toBe("allow")
    expect(specific?.permissionDecisionReason).toContain("retry allowance reached")
    expect(specific?.additionalContext).toContain("three guardian denials")
    expect(specific?.additionalContext).toContain("retry is permitted")
  })

  test("does not treat an ordinary command failure as proof escalation is needed", () => {
    const specific = getHookSpecificOutput(evaluate("failed"))
    expect(specific?.permissionDecision).toBe("deny")
    expect(specific?.permissionDecisionReason).toContain("did not establish a sandbox restriction")
  })
})
