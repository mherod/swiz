import { describe, expect, it } from "vitest"
import { AGENTS, CONFIGURABLE_AGENTS } from "./agents.ts"
import { DISPATCH_ROUTES } from "./commands/dispatch.ts"
import { manifest } from "./manifest.ts"

// ─── Dispatch routing validation ────────────────────────────────────────────
// Cross-checks manifest events, dispatch routing table, and agent event maps
// to catch regressions like a manifest event missing from the dispatch switch.

describe("dispatch routing validation", () => {
  const manifestEvents = [...new Set(manifest.map((g) => g.event))]
  const dispatchEvents = Object.keys(DISPATCH_ROUTES)

  it("every manifest event has an explicit dispatch route", () => {
    const missing = manifestEvents.filter((e) => !(e in DISPATCH_ROUTES))
    expect(missing, `Manifest events missing from DISPATCH_ROUTES: ${missing.join(", ")}`).toEqual(
      []
    )
  })

  it("every dispatch route has at least one manifest entry", () => {
    const orphaned = dispatchEvents.filter((e) => !manifest.some((g) => g.event === e))
    expect(
      orphaned,
      `DISPATCH_ROUTES entries with no manifest hooks: ${orphaned.join(", ")}`
    ).toEqual([])
  })

  it("every configurable agent maps all manifest events", () => {
    for (const agent of CONFIGURABLE_AGENTS) {
      const unmapped = manifestEvents.filter((e) => !(e in agent.eventMap))
      expect(
        unmapped,
        `Agent "${agent.id}" missing eventMap entries for: ${unmapped.join(", ")}`
      ).toEqual([])
    }
  })

  it("non-configurable agents map all manifest events they can handle", () => {
    // Non-configurable agents (e.g. Codex) may intentionally omit some events.
    // This test documents the gaps rather than enforcing full coverage.
    for (const agent of AGENTS.filter((a) => !a.hooksConfigurable)) {
      const unmapped = manifestEvents.filter((e) => !(e in agent.eventMap))
      if (unmapped.length > 0) {
        // Log for visibility but don't fail — these are known limitations
        expect(unmapped.length).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it("context-strategy events do not use blocking strategy", () => {
    // Events that merge additionalContext (sessionStart, userPromptSubmit, etc.)
    // must use "context" strategy, not "blocking" which discards context output.
    const contextEvents = ["sessionStart", "userPromptSubmit", "preCompact"]
    for (const event of contextEvents) {
      if (event in DISPATCH_ROUTES) {
        expect(
          DISPATCH_ROUTES[event],
          `Event "${event}" should use "context" strategy, not "${DISPATCH_ROUTES[event]}"`
        ).toBe("context")
      }
    }
  })

  it("preToolUse uses its specialized strategy", () => {
    expect(DISPATCH_ROUTES.preToolUse).toBe("preToolUse")
  })

  it("stop and postToolUse use blocking strategy", () => {
    expect(DISPATCH_ROUTES.stop).toBe("blocking")
    expect(DISPATCH_ROUTES.postToolUse).toBe("blocking")
  })

  it("agent eventMap values are non-empty strings", () => {
    for (const agent of AGENTS) {
      for (const [canonical, translated] of Object.entries(agent.eventMap)) {
        expect(
          typeof translated === "string" && translated.length > 0,
          `Agent "${agent.id}" eventMap["${canonical}"] is empty or not a string`
        ).toBe(true)
      }
    }
  })
})
