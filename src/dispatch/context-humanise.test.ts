import { describe, expect, it } from "bun:test"
import { shouldHumaniseContextOutput } from "./context-humanise.ts"

describe("shouldHumaniseContextOutput", () => {
  it("keeps UserPromptSubmit context mechanical even outside the grace window", () => {
    expect(
      shouldHumaniseContextOutput({
        canonicalEvent: "userPromptSubmit",
        humaniseEnabled: true,
        withinGrace: false,
      })
    ).toBe(false)
  })

  it("allows non-prompt context humanisation outside the grace window", () => {
    expect(
      shouldHumaniseContextOutput({
        canonicalEvent: "sessionStart",
        humaniseEnabled: true,
        withinGrace: false,
      })
    ).toBe(true)
  })

  it("does not humanise when disabled or inside the grace window", () => {
    expect(
      shouldHumaniseContextOutput({
        canonicalEvent: "sessionStart",
        humaniseEnabled: false,
        withinGrace: false,
      })
    ).toBe(false)
    expect(
      shouldHumaniseContextOutput({
        canonicalEvent: "sessionStart",
        humaniseEnabled: true,
        withinGrace: true,
      })
    ).toBe(false)
  })
})
