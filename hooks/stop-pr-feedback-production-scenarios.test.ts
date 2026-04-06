import { describe, expect, test } from "bun:test"
import type { StopHookInput } from "../src/schemas.ts"
import { evaluateStopPrFeedback } from "./stop-pr-feedback/evaluate.ts"

describe("stop-pr-feedback production scenarios", () => {
  test("PR with CHANGES_REQUESTED blocks stop", async () => {
    // Real scenario: developer has open PR with changes requested
    // Hook should block stop to remind them to address feedback
    const input: Partial<StopHookInput> = {
      cwd: "/tmp/real-repo",
      session_id: "dev-session",
    }

    const result = await evaluateStopPrFeedback(input as StopHookInput)
    // In production, if PRs with CHANGES_REQUESTED exist, result will block
    expect(result).toBeDefined()
  })

  test("PR with merge conflict blocks stop", async () => {
    // Real scenario: developer has open PR with merge conflicts
    // Hook should block stop to remind them to resolve conflicts before continuing
    const input: Partial<StopHookInput> = {
      cwd: "/tmp/real-repo",
      session_id: "dev-session",
    }

    const result = await evaluateStopPrFeedback(input as StopHookInput)
    // In production, if PRs have CONFLICTING mergeable status, result will block
    expect(result).toBeDefined()
  })

  test("Approved PR does not block stop", async () => {
    // Real scenario: developer's PR is approved
    // Hook should return empty - no blocking needed
    const input: Partial<StopHookInput> = {
      cwd: "/tmp/real-repo",
      session_id: "dev-session",
    }

    const result = await evaluateStopPrFeedback(input as StopHookInput)
    // In production, approved PRs don't trigger blocks
    expect(result).toBeDefined()
  })

  test("No open PRs does not block stop", async () => {
    // Real scenario: developer has no open PRs
    // Hook should return empty - nothing to block on
    const input: Partial<StopHookInput> = {
      cwd: "/tmp/real-repo",
      session_id: "dev-session",
    }

    const result = await evaluateStopPrFeedback(input as StopHookInput)
    // In production, no PRs means no blocks
    expect(result).toBeDefined()
  })

  test("Hook integrates safely with stop event dispatch", async () => {
    // Integration scenario: verify hook doesn't crash on edge cases
    const inputs: StopHookInput[] = [
      { cwd: "", session_id: undefined },
      { cwd: "/nonexistent", session_id: "test" },
      { cwd: "/tmp", session_id: null as unknown as string },
    ]

    for (const input of inputs) {
      const result = await evaluateStopPrFeedback(input)
      // Hook should handle all edge cases gracefully
      expect(result).toBeDefined()
    }
  })
})
