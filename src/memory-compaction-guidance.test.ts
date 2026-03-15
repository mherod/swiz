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
      "Remove unnecessary content:",
      [
        "Redundant modifiers, auxiliary verbs, and filler phrasing.",
        "Parenthetical restatements and duplicate bullets, sections, and topic lists.",
        "Narrative language ('we learned', 'this session', 'when we tried') — convert to directives or remove.",
      ],
      "Convert remaining content to direct DO/DON'T/Reference guidance.",
      "Preserve all technical specifics: names, IDs, URLs, commands, and numeric constraints.",
      "Apply surgical strategies: consolidate repeated topics, cross-reference instead of repeating, collapse similar lists.",
      "Re-check with `wc -w CLAUDE.md`.",
    ])
  })
})
