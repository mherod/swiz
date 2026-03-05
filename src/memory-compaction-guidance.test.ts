import { describe, expect, test } from "bun:test"
import {
  compactionChecklistSteps,
  manualCompactionFallback,
  manualCompactionGuidanceFallback,
} from "./memory-compaction-guidance.ts"

describe("memory-compaction-guidance", () => {
  test("manualCompactionFallback formats subject-specific guidance", () => {
    expect(manualCompactionFallback("CLAUDE.md")).toBe(
      "Compact CLAUDE.md manually: remove redundant modifiers and parenthetical restatements, collapse duplicate topics/lists, convert narrative/session notes to DO/DON'T/Reference directives, and preserve names/IDs/URLs/commands/thresholds."
    )
  })

  test("manualCompactionGuidanceFallback formats non-specific guidance", () => {
    expect(manualCompactionGuidanceFallback()).toBe(
      "Use compact-memory guidance manually: remove redundant modifiers and parenthetical restatements, collapse duplicate topics/lists, convert narrative/session notes to DO/DON'T/Reference directives, and preserve names/IDs/URLs/commands/thresholds."
    )
  })

  test("compactionChecklistSteps includes shared guidance and caller verification step", () => {
    const steps = compactionChecklistSteps("Re-check with `wc -w CLAUDE.md`.")
    expect(steps).toEqual([
      "Remove redundant modifiers, auxiliary verbs, and filler phrasing.",
      "Remove parenthetical restatements and duplicate bullets, sections, and topic lists.",
      "Convert narrative/session language into direct DO/DON'T/Reference guidance.",
      "Keep all technical specifics: names, IDs, URLs, commands, and numeric constraints.",
      "Re-check with `wc -w CLAUDE.md`.",
    ])
  })
})
