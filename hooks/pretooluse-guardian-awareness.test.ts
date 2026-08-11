import { describe, expect, test } from "bun:test"
import type { GuardianReviewContext } from "../src/guardian-review.ts"
import { getHookSpecificOutput } from "../src/utils/hook-specific-output.ts"
import { evaluateGuardianAwareness } from "./pretooluse-guardian-awareness.ts"

function evaluate(priorSandboxAttempt?: GuardianReviewContext["priorSandboxAttempt"]) {
  return evaluateGuardianAwareness({
    tool_name: "Bash",
    tool_input: { command: "git push origin main" },
    ...(priorSandboxAttempt
      ? {
          _guardianReview: {
            requested: true,
            source: "codex-transcript",
            priorSandboxAttempt,
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

  test("does not treat an ordinary command failure as proof escalation is needed", () => {
    const specific = getHookSpecificOutput(evaluate("failed"))
    expect(specific?.permissionDecision).toBe("deny")
    expect(specific?.permissionDecisionReason).toContain("did not establish a sandbox restriction")
  })
})
