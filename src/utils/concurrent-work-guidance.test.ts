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
    const guidance = buildConcurrentFileEditGuidance("src/shared.ts", "6m")

    expect(guidance).toContain("Another agent touched src/shared.ts 6m ago")
    expect(guidance).toContain("exact-file overlap")
    expect(guidance).toContain("not a change of plan")
    expect(guidance).toContain("Re-read src/shared.ts immediately before editing")
    expect(guidance).toContain("integrate both intents")
  })

  test("bypasses humanisation so the reassurance reaches the agent verbatim", async () => {
    const guidance = buildConcurrentWorkGuidance()

    expect(await humaniseText(guidance)).toBe(guidance)
  })

  test("keeps wait flows calm when the shared directory moves", () => {
    const guidance = buildConcurrentWaitGuidance("Waiting for authoritative CI results.")

    expect(guidance).toContain("Waiting for authoritative CI results.")
    expect(guidance).toContain("Don't panic. Continue as you were.")
    expect(guidance).toContain("Stay focused on your own task. It's going to be fine.")
    expect(guidance).toContain("Do not stash, revert, restore, reset, clean")
    expect(guidance).toContain("not, by themselves, a failure or conflict")
  })
})
