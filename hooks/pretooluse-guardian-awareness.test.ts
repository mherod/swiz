import { describe, expect, test } from "bun:test"
import type { GuardianReviewContext } from "../src/guardian-review.ts"
import { getHookSpecificOutput } from "../src/utils/hook-specific-output.ts"
import {
  evaluateGuardianAwareness,
  gitAddAvoidanceMessage,
} from "./pretooluse-guardian-awareness.ts"

async function evaluate(
  priorSandboxAttempt?: GuardianReviewContext["priorSandboxAttempt"],
  command = "git push origin main",
  recentGitAddGuardianDenialCount = 0
) {
  return await evaluateGuardianAwareness({
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
  test("allows ordinary sandboxed commands silently", async () => {
    const specific = getHookSpecificOutput(await evaluate())
    expect(specific?.permissionDecision).toBe("allow")
    expect(specific?.permissionDecisionReason).toBe("")
  })

  test("blocks proactive escalation and requests a sandboxed attempt", async () => {
    const output = await evaluate("not-attempted")
    const specific = getHookSpecificOutput(output)
    expect(specific?.permissionDecision).toBe("deny")
    expect(specific?.permissionDecisionReason).toContain("has not been attempted")
    expect(specific?.permissionDecisionReason).toContain("Retry without `sandbox_permissions")
  })

  test("blocks escalation after the sandboxed operation already succeeded", async () => {
    const specific = getHookSpecificOutput(await evaluate("succeeded"))
    expect(specific?.permissionDecision).toBe("deny")
    expect(specific?.permissionDecisionReason).toContain("already completed successfully")
    expect(specific?.permissionDecisionReason).toContain("incidental warning")
  })

  test("allows narrowly scoped escalation after a proven sandbox restriction", async () => {
    const specific = getHookSpecificOutput(await evaluate("permission-failed"))
    expect(specific?.permissionDecision).toBe("allow")
    expect(specific?.permissionDecisionReason).toContain("confirmed sandbox restriction")
    expect(specific?.additionalContext).toContain("narrowly scoped")
  })

  test("steers sandbox-blocked git add away from escalation", async () => {
    const specific = getHookSpecificOutput(
      await evaluate("permission-failed", "git add -- src/guardian-review.ts")
    )
    expect(specific?.permissionDecision).toBe("deny")
    expect(specific?.permissionDecisionReason).toContain("Guardian denial 1 of at most 3")
    expect(specific?.permissionDecisionReason).toContain("Retry permitted by guard")
    expect(specific?.permissionDecisionReason).toContain("you may retry")
    expect(specific?.permissionDecisionReason).toContain("git commit -a")
    expect(specific?.permissionDecisionReason).toContain("already tracked")
    expect(specific?.permissionDecisionReason).toContain("untracked")
  })

  test("allows the retry after three recent git add guardian denials", async () => {
    const specific = getHookSpecificOutput(
      await evaluate("permission-failed", "git add -- src/guardian-review.ts", 3)
    )
    expect(specific?.permissionDecision).toBe("allow")
    expect(specific?.permissionDecisionReason).toContain("retry allowance reached")
    expect(specific?.additionalContext).toContain("three guardian denials")
    expect(specific?.additionalContext).toContain("retry is permitted")
  })

  test("does not treat an ordinary command failure as proof escalation is needed", async () => {
    const specific = getHookSpecificOutput(await evaluate("failed"))
    expect(specific?.permissionDecision).toBe("deny")
    expect(specific?.permissionDecisionReason).toContain("did not establish a sandbox restriction")
  })
})

describe("gitAddAvoidanceMessage peer gating (issue #843 finding A)", () => {
  test("control: without peer files the commit -a route is offered", () => {
    const message = gitAddAvoidanceMessage(0, [])
    expect(message).toContain("git commit -a")
    expect(message).toContain("already tracked")
    expect(message).not.toContain("another live session")
  })

  test("peer files present: commit -a is refused and named as unsafe", () => {
    const message = gitAddAvoidanceMessage(0, ["src/theirs.ts", "hooks/also-theirs.ts"])
    expect(message).toContain("Do not use `git commit -a` here")
    expect(message).toContain("src/theirs.ts, hooks/also-theirs.ts")
    expect(message).toContain("stage their tracked modifications as yours")
    expect(message).not.toContain("run the normal commit workflow and then")
  })

  test("long peer lists are bounded", () => {
    const many = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`)
    const message = gitAddAvoidanceMessage(0, many)
    expect(message).toContain("src/f9.ts, …")
    expect(message).not.toContain("src/f11.ts")
  })
})
