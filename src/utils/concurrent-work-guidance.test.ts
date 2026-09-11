import { describe, expect, test } from "bun:test"
import {
  buildConcurrentFileEditGuidance,
  buildConcurrentWaitGuidance,
  buildConcurrentWorkGuidance,
} from "./concurrent-work-guidance.ts"
import { humaniseText } from "./humanise.ts"

describe("concurrent work guidance", () => {
  test("explicitly reassures an agent to continue its own task", () => {
    const guidance = buildConcurrentWorkGuidance()

    expect(guidance).toContain("Don't panic.")
    expect(guidance).toContain("Continue as you were.")
    expect(guidance).toContain("Stay focused on your own task.")
    expect(guidance).toContain("It's going to be fine.")
    expect(guidance).toContain(
      "Missing ownership evidence does not mean another session made a change; it may be yours."
    )
    expect(guidance).not.toContain("unrelated changes")
    expect(guidance).toContain("Do not stash, revert, restore, reset, clean")
  })

  test("limits special handling to an exact-file overlap", () => {
    const guidance = buildConcurrentFileEditGuidance("src/shared.ts", "2026-09-11T12:00:00.000Z")

    expect(guidance).toContain("Another agent touched src/shared.ts at 2026-09-11T12:00:00.000Z")
    expect(guidance).toContain("exact-file overlap")
    expect(guidance).toContain("not a change of plan")
    expect(guidance).toContain("Re-read src/shared.ts immediately before editing")
    expect(guidance).toContain("integrate both intents")
  })

  test("bypasses humanisation so the reassurance reaches the agent verbatim", async () => {
    const guidance = buildConcurrentWorkGuidance()

    expect(await humaniseText(guidance)).toBe(guidance)
  })

  test("keeps wait output to the operation instead of repeating checkout advice", () => {
    const guidance = buildConcurrentWaitGuidance("Waiting for authoritative CI results.")

    expect(guidance).toBe("ℹ Waiting for authoritative CI results.")
  })
})
