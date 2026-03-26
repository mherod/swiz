import { describe, expect, it } from "vitest"
import { getAgent, translateEvent } from "./agents.ts"

/**
 * Contract for Codex CLI hooks.json (v0.116.0+): user-facing keys are
 * SessionStart, Stop, UserPromptSubmit (openai/codex#13276). Swiz must not
 * regress to internal-style names (e.g. AfterAgent, BeforeAgent) for those
 * canonical events — see swiz#385.
 */
describe("Codex eventMap contract (hooks.json)", () => {
  const codex = getAgent("codex")!

  it("maps canonical stop/sessionStart/userPromptSubmit to shipped JSON keys", () => {
    expect(codex.eventMap.stop).toBe("Stop")
    expect(codex.eventMap.sessionStart).toBe("SessionStart")
    expect(codex.eventMap.userPromptSubmit).toBe("UserPromptSubmit")
  })

  it("translateEvent matches eventMap for shipped keys", () => {
    expect(translateEvent("stop", codex)).toBe("Stop")
    expect(translateEvent("sessionStart", codex)).toBe("SessionStart")
    expect(translateEvent("userPromptSubmit", codex)).toBe("UserPromptSubmit")
  })

  it("keeps tool-adjacent mappings on engine identifiers until exposed in user schema", () => {
    expect(codex.eventMap.preToolUse).toBe("BeforeToolUse")
    expect(codex.eventMap.postToolUse).toBe("AfterToolUse")
  })

  it("installs hooks now that Codex ships a stable hooks.json format", () => {
    expect(codex.hooksConfigurable).toBe(true)
  })
})
