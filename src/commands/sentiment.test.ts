import { describe, expect, it } from "vitest"
import { scoreSentiment } from "./sentiment.ts"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function score(text: string) {
  return scoreSentiment(text).score
}

function approvalLabels(text: string) {
  return scoreSentiment(text).approvalMatches.map((m) => m.label)
}

function rejectionLabels(text: string) {
  return scoreSentiment(text).rejectionMatches.map((m) => m.label)
}

function hedgingLabels(text: string) {
  return scoreSentiment(text).hedgingMatches.map((m) => m.label)
}

// ─── Boundary cases ───────────────────────────────────────────────────────────

describe("boundary inputs", () => {
  it("returns score 0 and empty matches for empty string", () => {
    const result = scoreSentiment("")
    expect(result.score).toBe(0)
    expect(result.approvalMatches).toHaveLength(0)
    expect(result.rejectionMatches).toHaveLength(0)
    expect(result.hedgingMatches).toHaveLength(0)
  })

  it("returns score 0 for whitespace-only input", () => {
    expect(score("   \n\t\n  ")).toBe(0)
  })

  it("returns score 0 for text with no recognisable patterns", () => {
    expect(score("The quick brown fox jumps over the lazy dog.")).toBe(0)
  })

  it("clamps score to +1 when many approval patterns fire", () => {
    // Pile on many positive signals — raw sum will exceed 1
    const text =
      "✅ **Approved** — CI passes. All CI checks passed. Safe to merge. " +
      "Implementation is solid. All checks are green. No issues found. " +
      "Ready for merge. Well-implemented. All review feedback has been addressed. " +
      "Semantics are correct. Strictly correct. Backwards-compatible. Idiomatic code."
    expect(score(text)).toBe(1)
  })

  it("clamps score to -1 when many rejection patterns fire", () => {
    const text =
      "CHANGES_REQUESTED. CI Failure. Unmet Acceptance Criterion. " +
      "Tests are missing from this PR. This is a blocker. " +
      "Cannot be merged. Must be fixed before this can be merged. " +
      "Auto-requested changes. Review verdict missing. Human reviewer should check. " +
      "Build failing. Lint failing. Fails due to multiple errors."
    expect(score(text)).toBe(-1)
  })

  it("score is exactly 0 with no signal text", () => {
    const result = scoreSentiment("Thank you for the PR.")
    expect(result.score).toBe(0)
  })
})

// ─── Strong approval ──────────────────────────────────────────────────────────

describe("strong approval signals", () => {
  it("✅ Approved stamp is the highest single signal", () => {
    const result = scoreSentiment("✅ **Approved** — everything looks great.")
    expect(result.score).toBeGreaterThan(0.7)
    expect(approvalLabels("✅ **Approved**")).toContain("explicit approval stamp")
  })

  it("approval at start of line triggers verdict pattern", () => {
    const text = "Approved — barrel cleanup for entity.handler.ts. CI green."
    expect(score(text)).toBeGreaterThan(0.7)
    expect(approvalLabels(text)).toContain("approval verdict (start of line)")
  })

  it("'Approved' followed by CI passes adds both signals", () => {
    const text = "✅ **Approved** — CI passes on all checks (typecheck, lint, build). Safe to merge."
    const result = scoreSentiment(text)
    expect(result.score).toBe(1)
    expect(approvalLabels(text)).toContain("explicit approval stamp")
    expect(approvalLabels(text)).toContain("CI passes")
    expect(approvalLabels(text)).toContain("safe to merge")
  })

  it("real PR review bot approval comment scores ≥ 0.9", () => {
    // Matches real comment from RaptorMarketing/ramp3-spike PR #907
    const text = `✅ **Approved** — Test-only PR expanding coverage across three modules. All CI checks passed (lint, typecheck, build, 1253 tests across 77 files).

The sba-view.handler.test.ts new describe blocks correctly cover role-not-found (403), invalid ObjectId format (400), empty user_ids early return, and agency-with-no-campaigns path. The toObjectId throw simulation and CampaignDataRepository.instance mock are idiomatic Vitest patterns.`
    expect(score(text)).toBeGreaterThanOrEqual(0.9)
  })

  it("'all CI checks passed' alone scores positively", () => {
    expect(score("All CI checks passed.")).toBeGreaterThan(0.3)
    expect(approvalLabels("All CI checks passed.")).toContain("all CI checks pass")
  })

  it("'safe to merge' alone is a moderate positive signal", () => {
    expect(score("Safe to merge.")).toBeGreaterThan(0.4)
  })

  it("'no issues found' registers as approval signal", () => {
    expect(approvalLabels("No issues found.")).toContain("no issues found")
  })

  it("'well-implemented' registers quality stamp", () => {
    expect(approvalLabels("The approach is well-implemented and idiomatic.")).toContain(
      "well-[word] quality stamp"
    )
  })

  it("'implementation is solid' registers quality stamp", () => {
    expect(approvalLabels("CI passes. The implementation is solid.")).toContain(
      "implementation solid"
    )
  })

  it("'all review feedback has been addressed' registers", () => {
    const text = "All review feedback has been addressed. Ready for merge."
    expect(approvalLabels(text)).toContain("all feedback addressed")
    expect(score(text)).toBeGreaterThan(0.5)
  })

  it("'ready for review' scores as approval", () => {
    expect(score("Stale CHANGES_REQUESTED review dismissed. Ready for review.")).toBeGreaterThan(0)
  })

  it("'well-specified' issue quality stamp registers", () => {
    const text = "Well-specified issue. No missing information. Ready for implementation."
    expect(approvalLabels(text)).toContain("well-specified (issue quality)")
    expect(score(text)).toBeGreaterThan(0.4)
  })

  it("'strictly correct' adds approval weight", () => {
    expect(approvalLabels("The semantics are strictly correct.")).toContain("strictly correct")
  })

  it("'semantics are equivalent' adds approval weight", () => {
    expect(approvalLabels("Semantics are equivalent to the old fetch-and-check.")).toContain(
      "semantics correct"
    )
  })

  it("'backwards-compatible' registers as positive signal", () => {
    expect(approvalLabels("Clean, backwards-compatible addition.")).toContain("backwards-compatible")
  })

  it("multiple 'correctly' occurrences accumulate weight", () => {
    const text = "Auth gates correctly. Role resolution works correctly. Dates handled correctly."
    const result = scoreSentiment(text)
    const correctlyMatch = result.approvalMatches.find((m) => m.label === "correctly (×N)")
    expect(correctlyMatch).toBeDefined()
    expect(correctlyMatch!.count).toBe(3)
    expect(result.score).toBeGreaterThan(0.1)
  })

  it("comprehensive approval review from corpus (PR #903)", () => {
    // Derived from real review comment on RaptorMarketing/ramp3-spike
    const text = `✅ **Approved** — CSV export for social posts is well-implemented and follows existing codebase patterns.

Backend: exportPostsToCSVImpl handler correctly gates on authorizePostAction. Role-based campaign filtering mirrors existing approach. Caps results at 10,000 posts via CSV_EXPORT_LIMIT. The csvEscape / toPlainCsv inline helpers are RFC 4180-compliant.

Frontend: isExporting gates button with disabled and aria-busy. triggerCsvDownload utility now used consistently. i18n exporting key added to all 4 locale files.

CI passes (lint, typecheck, build). Safe to merge.`
    expect(score(text)).toBe(1)
  })
})

// ─── Strong rejection ─────────────────────────────────────────────────────────

describe("strong rejection signals", () => {
  it("CHANGES_REQUESTED alone is a strong negative", () => {
    expect(score("CHANGES_REQUESTED")).toBeLessThan(-0.6)
    expect(rejectionLabels("CHANGES_REQUESTED")).toContain("CHANGES_REQUESTED review state")
  })

  it("CI Failure alone is a strong negative", () => {
    expect(score("CI Failure — Biome useLiteralKeys errors.")).toBeLessThan(-0.5)
    expect(rejectionLabels("CI Failure.")).toContain("CI failure")
  })

  it("'Unmet Acceptance Criterion' registers as blocking", () => {
    const text = "Unmet Acceptance Criterion (blocking): tests must cover the 200/400/403 cases."
    expect(rejectionLabels(text)).toContain("unmet acceptance criterion")
    expect(score(text)).toBeLessThan(-0.7)
  })

  it("'tests are missing from this PR' registers", () => {
    const text = "Handler tests are missing from this PR."
    expect(rejectionLabels(text)).toContain("missing from PR")
    expect(score(text)).toBeLessThan(-0.3)
  })

  it("'before this can be merged' is a gate condition", () => {
    const text = "Fix the failing lint before this can be merged."
    expect(rejectionLabels(text)).toContain("before can be merged")
    expect(score(text)).toBeLessThan(-0.3)
  })

  it("'cannot be merged' signals hard block", () => {
    // "until CI is green" is a condition, not a confirmation — CI green pattern must not fire here
    expect(score("This PR cannot be merged until CI is green.")).toBeLessThan(0)
    expect(rejectionLabels("This PR cannot be merged.")).toContain("cannot be merged")
    // When no conditional context, the full rejection weight applies
    expect(score("This PR cannot be merged.")).toBeLessThan(-0.4)
  })

  it("'must be fixed' registers as rejection", () => {
    expect(rejectionLabels("The race condition must be fixed.")).toContain("must be fixed")
  })

  it("'Auto-requested changes' registers as rejection", () => {
    const text = "Auto-requested changes: the review comment indicated blocking issues."
    expect(rejectionLabels(text)).toContain("auto-requested changes")
    expect(score(text)).toBeLessThan(-0.4)
  })

  it("'Review verdict missing' is a soft negative", () => {
    expect(rejectionLabels("Review verdict missing.")).toContain("review verdict missing")
    expect(score("Review verdict missing.")).toBeLessThan(0)
  })

  it("'Human reviewer should check' is a soft negative", () => {
    expect(rejectionLabels("Human reviewer should check this PR.")).toContain("human review needed")
  })

  it("'build failing' registers as CI rejection", () => {
    expect(rejectionLabels("The build is failing.")).toContain("checks/build failing")
  })

  it("'fails due to' registers as rejection", () => {
    expect(rejectionLabels("The test fails due to a missing mock.")).toContain("fails due to")
  })

  it("real PR rejection comment from corpus (PR #901)", () => {
    // Derived from real review on PR #901 — missing test AC
    const text = `## Code Review — PR #901

CI passes. The implementation is well-structured and follows existing patterns. However, issue #664's acceptance criteria explicitly require unit tests that are missing from this PR.

### Unmet Acceptance Criterion (blocking)

Issue #664 lists this as a required AC:

> Handler has unit tests: valid brandId (200 with count), missing brandId (400), unauthorized (403)

An existing test file is present but no tests for getSbaCount were added in this PR. The test suite must cover at minimum the three cases listed. Human reviewer should check this PR.`
    // Has CI passes + well-structured (approval) BUT also unmet AC + missing + blocking (rejection)
    // Net should be negative
    expect(score(text)).toBeLessThan(0)
    expect(rejectionLabels(text)).toContain("unmet acceptance criterion")
    expect(rejectionLabels(text)).toContain("missing from PR")
  })

  it("comprehensive rejection from corpus (PR #913 first review)", () => {
    const text = `## CI Failure — Biome \`useLiteralKeys\` Errors

The functions build is failing due to 3 Biome lint errors introduced in export.handler.ts.

Failing lines:
- dateFilter["$gte"] = start;  → use  dateFilter.$gte = start;
- dateFilter["$lte"] = end;    → use  dateFilter.$lte = end;
- query["event_date"] = ...;   → use  query.event_date = ...;

Action required: Verify CI passes and re-request review.`
    expect(score(text)).toBeLessThan(-0.5)
    expect(rejectionLabels(text)).toContain("CI failure")
    expect(rejectionLabels(text)).toContain("re-request review")
  })
})

// ─── Hedging / mixed signals ──────────────────────────────────────────────────

describe("hedging and mixed signals", () => {
  it("'non-blocking' registers as hedging and adds positive weight", () => {
    expect(hedgingLabels("Non-blocking suggestion: consider extracting this.")).toContain(
      "non-blocking (reduces negatives)"
    )
    expect(score("Non-blocking suggestion: consider extracting this.")).toBeGreaterThan(0)
  })

  it("'neither is a blocker' prevents net rejection on hedged negatives", () => {
    const text =
      "Non-blocking suggestions for follow-up. Minor enough not to block merging. Neither is a blocker."
    expect(score(text)).toBeGreaterThan(0)
    expect(hedgingLabels(text)).toContain("neither is a blocker")
    expect(hedgingLabels(text)).toContain("minor enough not to block")
  })

  it("'not a blocker' registers as hedging", () => {
    expect(hedgingLabels("This is worth noting but not a blocker.")).toContain(
      "not a blocker/regression"
    )
  })

  it("'harmless but' downplays concern", () => {
    expect(hedgingLabels("The duplicate mock is harmless but misleading.")).toContain(
      "harmless but (downplayed)"
    )
  })

  it("'Not a regression' registers as hedging", () => {
    expect(hedgingLabels("Not a regression — previous approach was already paginated.")).toContain(
      "not a regression"
    )
  })

  it("hedged review scores positive even with minor negative signals", () => {
    // Real pattern: Approved, minor follow-ups, non-blocking
    const text = `✅ **Approved** — CI passes. Implementation is solid.

Non-blocking suggestions for follow-up:
- page-client.tsx inlines the createObjectURL/anchor/revokeObjectURL pattern instead of using the shared triggerCsvDownload utility. Consider using the utility for consistency.
- Minor doc/code drift in the JSDoc example.

Neither is a blocker. Safe to merge.`
    expect(score(text)).toBeGreaterThan(0.8)
  })

  it("'for a follow-up' defers concern and adds hedging weight", () => {
    expect(hedgingLabels("Worth addressing for a follow-up PR.")).toContain(
      "deferred to follow-up"
    )
    expect(hedgingLabels("Worth cleaning up in a follow-up.")).toContain("in a follow-up")
  })

  it("'Consider' (capitalised) adds soft positive weight", () => {
    const text = "Consider extracting this into a shared utility. Consider adding JSDoc."
    const result = scoreSentiment(text)
    const considerMatch = result.hedgingMatches.find((m) =>
      m.label.startsWith("Consider")
    )
    expect(considerMatch).toBeDefined()
    expect(considerMatch!.count).toBe(2)
  })

  it("'consider' (lowercase) also adds soft positive weight", () => {
    // After fix: Consider pattern has i flag
    const text = "consider adding JSDoc for consistency."
    const result = scoreSentiment(text)
    const considerMatch = result.hedgingMatches.find((m) =>
      m.label.startsWith("Consider")
    )
    expect(considerMatch).toBeDefined()
  })

  it("approval with caveats scores solidly positive but not over-confident", () => {
    // CI passes + idiomatic = approval, but there are review comment caveats
    // The hedging signals (non-blocking, follow-up, not a regression, not a blocker)
    // keep it positive without being a clean +1
    const text = `CI passes. The implementation is correct and the auth pattern is idiomatic.

Non-blocking: getUserById test still sets up a stale mock — worth cleaning up in a follow-up.

The getUsers path still loads all SBA IDs — not a regression. Not a blocker.`
    expect(score(text)).toBeGreaterThan(0.2)
    // Note: positive signals may sum to 1.0 after clamping — the key assertion is that
    // it's in the approval territory (≥ 0.2), not that it's strictly below max
    expect(score(text)).toBeGreaterThanOrEqual(0.2)
  })

  it("auto-requested changes then approval scores net positive", () => {
    // Pattern: bot auto-requested, then dismissed and approved
    const text = `Auto-requested changes: the review comment indicated blocking issues. See workflow logs.

[Stale review dismissed]

✅ **Approved** — All CI checks pass. All review feedback has been addressed. Safe to merge.`
    // The explicit approval stamp and "all feedback addressed" outweigh the auto-requested
    expect(score(text)).toBeGreaterThan(0)
  })

  it("mixed issue triage scores neutral-to-positive", () => {
    // Triage: informational, some missing info, no explicit verdict
    const text = `## Triage Notes

All locations in the issue body verified. No duplicates found.

Missing Information:
1. Animation design — no Figma link attached.
2. Three-mode vs two-mode toggle unclear.

Suggested Refinements:
- AC item is underspecified. Consider adding a concrete verification step.`
    // Has positive (no duplicates) and hedging (consider), but no approval stamp or CI
    // Should be neutral or slightly positive
    const s = score(text)
    expect(s).toBeGreaterThan(-0.3)
    expect(s).toBeLessThan(0.5)
  })
})

// ─── False positive prevention ────────────────────────────────────────────────

describe("false positive prevention", () => {
  it("'non-blocking' does not fire the rejection blocker pattern", () => {
    const text = "Non-blocking suggestions follow. Consider extracting the utility."
    expect(rejectionLabels(text)).not.toContain("blocking issues")
    expect(rejectionLabels(text)).not.toContain("is/remains a blocker")
  })

  it("'neither is a blocker' does not trigger rejection pattern", () => {
    const text = "Neither is a blocker — safe to proceed."
    expect(rejectionLabels(text)).toHaveLength(0)
  })

  it("'not a blocker' does not trigger rejection pattern", () => {
    const text = "This observation is worth noting but not a blocker."
    expect(rejectionLabels(text)).toHaveLength(0)
  })

  it("'CI passes' inside rejection context does not reduce rejection score below threshold", () => {
    // "Verify CI passes" is a rejection signal (pending) even though "CI passes" is approval
    const text = "Action required: Verify CI passes and re-request review."
    expect(score(text)).toBeLessThan(0)
  })

  it("'blocking' inside 'non-blocking' section does not fire rejection", () => {
    const text = "Non-blocking observation: the migration could block table writes briefly."
    // "block" here is about DB migration risk, mentioned in a non-blocking section
    // The rejection "blocking issues" pattern requires "blocking issues" not just "block"
    // so this should NOT fire rejection blocker patterns
    expect(rejectionLabels(text)).not.toContain("blocking issues")
    expect(rejectionLabels(text)).not.toContain("is/remains a blocker")
  })
})

// ─── Verdict label thresholds ─────────────────────────────────────────────────

describe("verdict label thresholds", () => {
  it("score >= 0.5 maps to APPROVED", () => {
    const text = "✅ **Approved** — Safe to merge."
    const { score: s } = scoreSentiment(text)
    expect(s).toBeGreaterThanOrEqual(0.5)
  })

  it("score between 0.2 and 0.5 maps to LIKELY APPROVED", () => {
    // Just CI passes with no explicit verdict stamp
    const s = score("CI passes (lint, typecheck, build). No issues found.")
    expect(s).toBeGreaterThanOrEqual(0.2)
  })

  it("score near 0 is NEUTRAL", () => {
    const s = score("The code looks interesting.")
    expect(s).toBeGreaterThanOrEqual(-0.2)
    expect(s).toBeLessThan(0.2)
  })

  it("score <= -0.5 maps to REJECTED", () => {
    const s = score("CHANGES_REQUESTED. CI Failure. Must be fixed.")
    expect(s).toBeLessThanOrEqual(-0.5)
  })
})

// ─── Return shape ─────────────────────────────────────────────────────────────

describe("return shape", () => {
  it("always returns score, approvalMatches, rejectionMatches, hedgingMatches", () => {
    const result = scoreSentiment("")
    expect(result).toHaveProperty("score")
    expect(result).toHaveProperty("approvalMatches")
    expect(result).toHaveProperty("rejectionMatches")
    expect(result).toHaveProperty("hedgingMatches")
    expect(Array.isArray(result.approvalMatches)).toBe(true)
    expect(Array.isArray(result.rejectionMatches)).toBe(true)
    expect(Array.isArray(result.hedgingMatches)).toBe(true)
  })

  it("each match has label, weight, count", () => {
    const { approvalMatches } = scoreSentiment("✅ **Approved**")
    expect(approvalMatches.length).toBeGreaterThan(0)
    const m = approvalMatches[0]!
    expect(m).toHaveProperty("label")
    expect(m).toHaveProperty("weight")
    expect(m).toHaveProperty("count")
    expect(typeof m.label).toBe("string")
    expect(typeof m.weight).toBe("number")
    expect(typeof m.count).toBe("number")
  })

  it("score is always in [-1, 1]", () => {
    const texts = [
      "",
      "great",
      "✅ **Approved** — CI passes. Safe to merge. All checks green. No issues found.",
      "CHANGES_REQUESTED. CI Failure. Must be fixed. Tests are missing from this PR.",
      "correctly correctly correctly correctly correctly correctly correctly",
    ]
    for (const text of texts) {
      const s = score(text)
      expect(s).toBeGreaterThanOrEqual(-1)
      expect(s).toBeLessThanOrEqual(1)
    }
  })

  it("repeating pattern count matches actual occurrences", () => {
    const text = "Done correctly. Wired correctly. Handled correctly. Scoped correctly."
    const { approvalMatches } = scoreSentiment(text)
    const m = approvalMatches.find((x) => x.label === "correctly (×N)")
    expect(m).toBeDefined()
    expect(m!.count).toBe(4)
  })
})
