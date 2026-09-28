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
    expect(specific?.permissionDecisionReason).toContain("missing-cwd")
    expect(specific?.permissionDecisionReason).not.toContain("git commit -a")
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

describe("Codex Git sandbox context", () => {
  async function advise(command: string, agent = "codex") {
    return getHookSpecificOutput(
      await evaluateGuardianAwareness({
        _agent: agent,
        tool_name: "Bash",
        tool_input: { command },
      })
    )
  }

  test.each([
    "git fetch origin && git rev-parse HEAD origin/main",
    "git status --short; git fetch origin",
    "git fetch origin\ngit log -1",
    "git -C '/repo with spaces' fetch origin",
    "git -c credential.helper= fetch origin",
    "git add -- README.md && git diff --cached",
  ])("adds context without granting permission: %s", async (command) => {
    const specific = await advise(command)
    expect(specific?.permissionDecision).toBeUndefined()
    expect(specific?.additionalContext).toContain(".git/FETCH_HEAD")
    expect(specific?.additionalContext).toContain("separate tool calls")
    expect(specific?.additionalContext).toContain("workdir")
    expect(specific?.additionalContext).toContain("Preserve required Git options")
    expect(specific?.additionalContext).toContain("does not override a denied approval")
  })

  test.each([
    "git fetch origin",
    "git status --short && git rev-parse HEAD",
    "git log --format='fetch && push'",
    "printf '%s' 'git fetch origin && git rev-parse HEAD'",
    "rg 'git fetch origin' README.md",
    "git fetch 'remote;name'",
  ])("keeps ordinary calls and quoted command text quiet: %s", async (command) => {
    expect((await advise(command))?.additionalContext).toBeUndefined()
  })

  test("keeps Codex-specific advice out of other agents", async () => {
    const command = "git fetch origin && git rev-parse HEAD"
    expect((await advise(command, "claude"))?.additionalContext).toBeUndefined()
  })

  test("explains recovery for an isolated Git permission failure", async () => {
    const specific = getHookSpecificOutput(await evaluate("permission-failed", "git fetch origin"))
    expect(specific?.additionalContext).toContain(".git/FETCH_HEAD")
    expect(specific?.additionalContext).toContain("ordinary sandbox first")
    expect(specific?.additionalContext).toContain("exact permission error")
  })

  test("preserves the denial after successful compound Git work", async () => {
    const specific = getHookSpecificOutput(
      await evaluate("succeeded", "git fetch origin && git rev-parse HEAD")
    )
    expect(specific?.permissionDecision).toBe("deny")
    expect(specific?.additionalContext).toBeUndefined()
  })
})

describe("gitAddAvoidanceMessage peer gating (issue #843 finding A)", () => {
  test("control: without peer files the commit -a route is offered", () => {
    const message = gitAddAvoidanceMessage(0, { known: true, files: [] })
    expect(message).toContain("git commit -a")
    expect(message).toContain("already tracked")
    expect(message).not.toContain("another live session")
  })

  test("peer files present: commit -a is refused and named as unsafe", () => {
    const message = gitAddAvoidanceMessage(0, {
      known: true,
      files: ["src/theirs.ts", "hooks/also-theirs.ts"],
    })
    expect(message).toContain("Do not use `git commit -a` here")
    expect(message).toContain("src/theirs.ts, hooks/also-theirs.ts")
    expect(message).toContain("stage their tracked modifications as yours")
    expect(message).not.toContain("run the normal commit workflow and then")
  })

  test("long peer lists are bounded", () => {
    const many = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`)
    const message = gitAddAvoidanceMessage(0, { known: true, files: many })
    expect(message).toContain("src/f9.ts, …")
    expect(message).not.toContain("src/f11.ts")
  })
  test("unknown discovery offers inspection without a whole-tree commit route", () => {
    const message = gitAddAvoidanceMessage(0, { known: false, reason: "query-failed" })
    expect(message).toContain("Inspect the intended checkout")
    expect(message).not.toContain("git commit -a")
  })
})
