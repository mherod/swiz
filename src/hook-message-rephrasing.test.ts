import { describe, expect, test } from "bun:test"
import { rephraseHookMessage } from "./hook-message-rephrasing.ts"

describe("rephraseHookMessage", () => {
  test("rephrases positive task-governance wording", () => {
    expect(rephraseHookMessage("Continue in good task hygiene mode.", () => 0)).toBe(
      "Stay in brilliant task practice mode."
    )
  })

  test("rephrases repeated negative wording in one pass", () => {
    expect(rephraseHookMessage("Poor task hygiene is risky.", () => 0)).toBe(
      "Concerning task practice is poor."
    )
  })

  test("rephrases continue-automatically wording", () => {
    expect(rephraseHookMessage("The workflow will continue automatically.", () => 0)).toBe(
      "The workflow will keep going automatically."
    )
  })

  test("rephrases common adjectives and nouns", () => {
    expect(rephraseHookMessage("Important current plan keeps active work healthy.", () => 0)).toBe(
      "Essential present strategy keeps ongoing work sound."
    )
  })

  test("rephrases progress wording", () => {
    expect(rephraseHookMessage("The project shows progress.", () => 0)).toBe(
      "The project shows advance."
    )
  })

  test("rephrases guidance adjectives", () => {
    expect(
      rephraseHookMessage(
        "Clear and specific guidance keeps the work useful, focused, stable, and ready.",
        () => 0
      )
    ).toBe(
      "Explicit and precise guidance keeps the work helpful, intentional, steady, and prepared."
    )
  })

  test("rephrases imperative guidance phrases", () => {
    expect(
      rephraseHookMessage(
        "Don't try to continue because this requires action and can overwhelm or overload the queue.",
        () => 0
      )
    ).toBe(
      "Avoid attempt to keep going because this needs action and can flood or burden the queue."
    )
  })

  test("rephrases catch and detect wording", () => {
    expect(rephraseHookMessage("It catches and detects issues.", () => 0)).toBe(
      "It spots and flags issues."
    )
  })

  test("rephrases aim-for wording", () => {
    expect(rephraseHookMessage("Aim for an important goal.", () => 0)).toBe(
      "Target an essential goal."
    )
  })

  test("rephrases modal guidance phrases", () => {
    expect(
      rephraseHookMessage(
        "We should continue, we must continue, and we can try to continue.",
        () => 0
      )
    ).toBe("We ought to keep going, we need to keep going, and we can attempt to keep going.")
  })

  test("rephrases add-create guidance phrases", () => {
    expect(
      rephraseHookMessage("Add one more pending task and create another follow-up.", () => 0)
    ).toBe("Add another pending task and make another follow-up.")
  })

  test("rephrases obligation and verification phrases", () => {
    expect(
      rephraseHookMessage("We need to continue, and we have to ensure the task is ready.", () => 0)
    ).toBe("We have to keep going, and we need to make sure the task is prepared.")
  })

  test("rephrases make-sure wording", () => {
    expect(rephraseHookMessage("Make sure to check and verify.", () => 0)).toBe(
      "Be sure to inspect and confirm."
    )
  })

  test("rephrases everyday guidance words", () => {
    expect(rephraseHookMessage("A simple and better approach is possible.", () => 0)).toBe(
      "A straightforward and improved approach is feasible."
    )
  })

  test("rephrases problem-language wording", () => {
    expect(rephraseHookMessage("The hard problem is likely.", () => 0)).toBe(
      "The difficult issue is probable."
    )
  })

  test("rephrases task-governance scaffolding", () => {
    expect(
      rephraseHookMessage(
        "Warning: What are we working on? Create tasks before starting implementation.",
        () => 0
      )
    ).toBe("Heads-up: What's the current focus? Set up tasks before starting implementation.")
  })

  test("rephrases claim assign stay remain and action-plan wording", () => {
    expect(
      rephraseHookMessage(
        "Claim and assign, stay or remain, allowed or approved, action plan.",
        () => 0
      )
    ).toBe("Take on and allocate, remain or stay, permitted or authorized, plan of action.")
  })

  test("stabilizes default selection within a five-minute window", () => {
    const originalNow = Date.now
    Date.now = () => 1_710_000_000_000
    try {
      const first = rephraseHookMessage("Continue in good task hygiene mode.")
      const second = rephraseHookMessage("Continue in good task hygiene mode.")
      expect(first).toBe(second)
      expect(first).not.toBe("Continue in good task hygiene mode.")
    } finally {
      Date.now = originalNow
    }
  })
})
