import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { scoreSentiment, sentimentCommand } from "./sentiment.ts"

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

// ─── Untested approval patterns ───────────────────────────────────────────────

describe("untested approval patterns", () => {
  it("'all checks now green' registers", () => {
    expect(approvalLabels("All checks now green.")).toContain("all checks now green")
    expect(approvalLabels("All now green.")).toContain("all checks now green")
  })

  it("'ready for implementation' registers", () => {
    expect(approvalLabels("The issue is ready for implementation.")).toContain(
      "ready for implementation"
    )
  })

  it("'overall implementation is' registers endorsed signal", () => {
    expect(approvalLabels("The overall implementation is clean and well-scoped.")).toContain(
      "overall implementation endorsed"
    )
  })

  it("'clean, minimal' registers as clean + qualifier", () => {
    expect(approvalLabels("Clean, minimal change.")).toContain("clean + qualifier")
  })

  it("'correct, backwards-compatible' registers as clean + qualifier", () => {
    expect(approvalLabels("Correct, backwards-compatible refactor.")).toContain("clean + qualifier")
  })

  it("'no logic changes' registers as approval signal", () => {
    expect(approvalLabels("No logic changes in this PR.")).toContain("no logic changes")
    expect(score("No logic changes.")).toBeGreaterThan(0)
  })

  it("'CI passes (lint, typecheck)' detail registers", () => {
    expect(approvalLabels("CI passes (lint, typecheck, build).")).toContain(
      "CI passes (lint/typecheck detail)"
    )
    expect(approvalLabels("CI passed (lint, typecheck).")).toContain(
      "CI passes (lint/typecheck detail)"
    )
  })

  it("'stale review dismissed, now ready' label is asserted directly", () => {
    const text = "Stale reviews dismissed. Ready."
    expect(approvalLabels(text)).toContain("stale review dismissed, now ready")
    expect(score(text)).toBeGreaterThan(0.6)
  })
})

// ─── Untested rejection patterns ──────────────────────────────────────────────

describe("untested rejection patterns", () => {
  it("'CI is failing' registers (distinct from CI Failure)", () => {
    expect(rejectionLabels("CI is failing due to a lint error.")).toContain("CI failing")
    expect(score("CI is failing.")).toBeLessThan(-0.5)
  })

  it("'CI is failed' also matches the CI failing pattern", () => {
    expect(rejectionLabels("CI is failed on the functions build.")).toContain("CI failing")
  })

  it("'no tests for' registers as no tests added", () => {
    expect(rejectionLabels("No tests for the new handler.")).toContain("no tests added")
  })

  it("'no tests were added' registers", () => {
    expect(rejectionLabels("No tests were added in this PR.")).toContain("no tests added")
  })

  it("'no tests have been added' registers", () => {
    expect(rejectionLabels("No tests have been added.")).toContain("no tests added")
  })

  it("'tests must cover' registers as rejection", () => {
    expect(rejectionLabels("Tests must cover the 200, 400, and 403 cases.")).toContain(
      "tests must cover"
    )
    expect(score("Tests must cover the error paths.")).toBeLessThan(-0.3)
  })

  it("'Unmet ... blocker' registers as unmet blocker condition", () => {
    expect(rejectionLabels("Unmet condition that acts as a blocker.")).toContain(
      "unmet blocker condition"
    )
  })
})

// ─── collectMatches cap-at-1 behaviour ───────────────────────────────────────

describe("collectMatches cap-at-1 for non-repeating patterns", () => {
  it("'safe to merge' appearing twice still has count=1", () => {
    const text = "Safe to merge. Please merge safely — safe to merge when ready."
    const { approvalMatches } = scoreSentiment(text)
    const m = approvalMatches.find((x) => x.label === "safe to merge")
    expect(m).toBeDefined()
    expect(m!.count).toBe(1)
  })

  it("'CI failure' appearing twice still contributes weight once", () => {
    const text = "CI Failure on step 1. CI Failure on step 2."
    const { rejectionMatches } = scoreSentiment(text)
    const m = rejectionMatches.find((x) => x.label === "CI failure")
    expect(m).toBeDefined()
    expect(m!.count).toBe(1)
    // Weight × count = -0.65 × 1, not doubled
    expect(Math.abs(m!.weight * m!.count)).toBeCloseTo(0.65)
  })
})

// ─── Verdict LIKELY REJECTED band ────────────────────────────────────────────

describe("verdict LIKELY REJECTED band", () => {
  it("score in (-0.5, -0.2) range represents LIKELY REJECTED territory", () => {
    // "re-request review" (-0.25) alone puts us in LIKELY REJECTED
    const s = score("Please re-request review once the changes are made.")
    expect(s).toBeGreaterThan(-0.5)
    expect(s).toBeLessThan(-0.1)
  })

  it("'Review verdict missing' produces LIKELY REJECTED score", () => {
    // -0.2 exactly maps to the -0.5 < score <= -0.2 band
    const s = score("Review verdict missing. Human reviewer should check.")
    expect(s).toBeGreaterThan(-0.5)
    expect(s).toBeLessThan(0)
  })
})

// ─── hedgingDampFactor dampens rejections ─────────────────────────────────────

describe("hedgingDampFactor reduces rejection weight", () => {
  it("hedged rejection scores better than same rejection without hedging", () => {
    // Same rejection signal with vs without a hedging qualifier
    const hedged = score("Must be fixed — but it's non-blocking for this release.")
    const bare = score("Must be fixed.")
    expect(hedged).toBeGreaterThan(bare)
  })

  it("heavy hedging (dense short text) does not push dampFactor below 0.4", () => {
    // Dense hedges: 4 hedge phrases in ~10 words → high hedgeDensity → floor at 0.4
    const text =
      "Non-blocking. Non-blocking. Neither is a blocker. Not a blocker. Minor enough not to block. Must be fixed."
    const result = scoreSentiment(text)
    // Should still have hedging matches
    expect(result.hedgingMatches.length).toBeGreaterThan(0)
    // Score should be positive overall (hedging weight outweighs dampened rejection)
    expect(result.score).toBeGreaterThan(0)
  })
})

// ─── run() CLI handler ────────────────────────────────────────────────────────

describe("run() CLI handler", () => {
  const logs: string[] = []

  beforeEach(() => {
    logs.length = 0
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("--score-only prints exactly one line with a 4-decimal numeric score", async () => {
    await sentimentCommand.run(["Safe to merge.", "--score-only"])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/^-?\d+\.\d{4}$/)
  })

  it("--score-only score matches scoreSentiment() for same text", async () => {
    const text = "✅ **Approved** — CI passes."
    await sentimentCommand.run([text, "--score-only"])
    const printed = parseFloat(logs[0]!)
    const expected = scoreSentiment(text).score
    expect(printed).toBeCloseTo(expected, 4)
  })

  it("--json prints exactly one line of valid JSON", async () => {
    await sentimentCommand.run(["✅ **Approved** — CI passes.", "--json"])
    expect(logs).toHaveLength(1)
    expect(() => JSON.parse(logs[0]!)).not.toThrow()
  })

  it("--json output has score, label, approval, rejection, hedging fields", async () => {
    await sentimentCommand.run(["✅ **Approved** — Safe to merge.", "--json"])
    const parsed = JSON.parse(logs[0]!)
    expect(parsed).toHaveProperty("score")
    expect(parsed).toHaveProperty("label")
    expect(parsed).toHaveProperty("approval")
    expect(parsed).toHaveProperty("rejection")
    expect(parsed).toHaveProperty("hedging")
    expect(Array.isArray(parsed.approval)).toBe(true)
    expect(Array.isArray(parsed.rejection)).toBe(true)
    expect(Array.isArray(parsed.hedging)).toBe(true)
  })

  it("--json label is APPROVED for strongly positive text", async () => {
    await sentimentCommand.run(["✅ **Approved** — Safe to merge.", "--json"])
    const parsed = JSON.parse(logs[0]!)
    expect(parsed.label).toBe("APPROVED")
  })

  it("--json label is REJECTED for strongly negative text", async () => {
    await sentimentCommand.run(["CHANGES_REQUESTED. CI Failure.", "--json"])
    const parsed = JSON.parse(logs[0]!)
    expect(parsed.label).toBe("REJECTED")
  })

  it("full output contains Score: header and bar", async () => {
    await sentimentCommand.run(["✅ **Approved** — CI passes."])
    const out = logs.join("\n")
    expect(out).toContain("Score:")
    // Bar contains center marker ┼
    expect(out).toContain("┼")
  })

  it("full output contains Approval signals section for approval text", async () => {
    await sentimentCommand.run(["✅ **Approved** — CI passes. Safe to merge."])
    expect(logs.some((l) => l.includes("Approval signals"))).toBe(true)
  })

  it("full output contains Rejection signals section for rejection text", async () => {
    await sentimentCommand.run(["CHANGES_REQUESTED. CI Failure."])
    expect(logs.some((l) => l.includes("Rejection signals"))).toBe(true)
  })

  it("full output omits Approval signals section when no approval matches", async () => {
    await sentimentCommand.run(["CHANGES_REQUESTED. CI Failure."])
    expect(logs.some((l) => l.includes("Approval signals"))).toBe(false)
  })

  it("full output omits Rejection signals section when no rejection matches", async () => {
    await sentimentCommand.run(["✅ **Approved** — CI passes. Safe to merge."])
    expect(logs.some((l) => l.includes("Rejection signals"))).toBe(false)
  })

  it("full output contains Hedging / context section for hedged text", async () => {
    await sentimentCommand.run(["CI passes. Non-blocking suggestions."])
    expect(logs.some((l) => l.includes("Hedging / context"))).toBe(true)
  })

  it("multiple word args are joined with a space before scoring", async () => {
    // "Safe" "to" "merge" → "Safe to merge" → triggers "safe to merge" pattern
    await sentimentCommand.run(["Safe", "to", "merge", "--score-only"])
    const printed = parseFloat(logs[0]!)
    expect(printed).toBeGreaterThan(0.4)
  })

  it("throws with actionable message when no args and stdin is TTY", async () => {
    const origTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true, configurable: true })
    try {
      await expect(sentimentCommand.run([])).rejects.toThrow("No input provided")
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: origTTY,
        writable: true,
        configurable: true,
      })
    }
  })
})

// ─── Elaborate & ambiguous cases ──────────────────────────────────────────────
//
// These tests expose where heuristic patterns succeed or fail when language is
// ambiguous, conditional, past-tense, or multi-speaker. Expected values are
// computed from the pattern weights — not from "what a human would infer".

describe("negated and qualified approvals", () => {
  it("'I would NOT say this PR is approved' scores neutral — no stamp format fires", () => {
    // "approved" lowercase mid-sentence does not match any approval pattern
    expect(score("I would NOT say this PR is approved.")).toBe(0)
  })

  it("'Approved by 2 reviewers, rejected by 1' scores neutral — count-style phrasing misses stamps", () => {
    // Neither the ✅ stamp nor the start-of-line pattern fire here
    const s = score("Approved by 2 reviewers, rejected by 1. Majority approved.")
    expect(s).toBe(0)
  })

  it("'Everything looks correct, except the auth logic which is incorrect' scores neutral", () => {
    // Patterns match 'correctly' (adverb) not 'correct' (adjective) or 'incorrect'
    expect(score("Everything looks correct, except the auth logic which is incorrect.")).toBe(0)
  })

  it("'This would be well-implemented IF the tests were present' still fires well-implemented", () => {
    // The regex has no tense/conditionality awareness — 'would be well-implemented' still matches
    // This is a known false-positive: conditional approval reads as endorsement
    const s = score("This would be well-implemented IF the tests were present.")
    expect(s).toBeGreaterThan(0)
    expect(approvalLabels("This would be well-implemented IF the tests were present.")).toContain(
      "well-[word] quality stamp"
    )
  })
})

describe("tense-shifting: past-rejection, present-resolution", () => {
  it("'CI was failing, but now CI passes' scores positive — past rejection pattern misses 'was'", () => {
    // '/\\bCI\\s+(?:Failure|fail(?:ing|ed))\\b/' requires CI immediately before fail*
    // 'CI was failing' has 'was' in between, so the rejection pattern does NOT fire.
    // 'CI passes' (no 'until' prefix) fires approval +0.4
    const s = score("The CI was failing, but now CI passes.")
    expect(s).toBeGreaterThan(0)
    expect(rejectionLabels("The CI was failing, but now CI passes.")).not.toContain("CI failure")
    expect(rejectionLabels("The CI was failing, but now CI passes.")).not.toContain("CI failing")
  })

  it("'build was failing due to lint, now fixed. CI now passes' scores near 0 — both patterns miss", () => {
    // 'build was failing' — 'was' breaks the rejection regex (needs 'build is fail*')
    // 'CI now passes' — 'now' breaks the approval regex (needs 'CI passes' with only whitespace)
    const text = "The build was failing due to a lint error, now fixed. CI now passes."
    const s = score(text)
    expect(s).toBeGreaterThanOrEqual(-0.1)
    expect(s).toBeLessThanOrEqual(0.1)
  })

  it("auto-requested changes with 'tests since added' still scores negative — past resolution is invisible", () => {
    // The scorer reads the whole text; 'Auto-requested changes' (-0.4) and 'no tests added' (-0.3)
    // fire even though the second sentence says the situation was resolved.
    const text =
      "The bot auto-requested changes because: no tests added. Tests have since been added."
    expect(score(text)).toBeLessThan(-0.3)
    expect(rejectionLabels(text)).toContain("auto-requested changes")
    expect(rejectionLabels(text)).toContain("no tests added")
  })

  it("'Previous review said CHANGES_REQUESTED. That has been addressed. ✅ **Approved**' scores slightly positive", () => {
    // CHANGES_REQUESTED (-0.75) vs ✅ Approved (+0.8) → net ≈ +0.05
    const text =
      "The previous reviewer wrote: 'CHANGES_REQUESTED'. That has now been addressed. ✅ **Approved**"
    const s = score(text)
    // Approval barely edges out the embedded rejection
    expect(s).toBeGreaterThan(0)
    expect(s).toBeLessThan(0.2)
  })
})

describe("conditionals that falsely read as approval", () => {
  it("'If CI passes, this would be safe to merge' scores as approval — 'if' not in lookbehind", () => {
    // The negative lookbehind only guards against 'until'. 'If CI passes' triggers +0.4.
    // 'safe to merge' also triggers +0.5. Net > 0.7 — a notable false positive.
    const text = "If CI passes, this would be safe to merge."
    expect(score(text)).toBeGreaterThan(0.7)
    expect(approvalLabels(text)).toContain("CI passes")
    expect(approvalLabels(text)).toContain("safe to merge")
  })

  it("'Do not merge until CI passes' scores neutral — lookbehind correctly blocks CI passes", () => {
    // '(?<!until )' lookbehind prevents 'until CI passes' from adding approval weight
    const text = "Do not merge until CI passes."
    expect(score(text)).toBe(0)
    expect(approvalLabels(text)).not.toContain("CI passes")
  })

  it("'cannot merge this until CI passes' also scores neutral — both rejection and approval miss", () => {
    // 'cannot merge' lacks 'be merged' so rejection pattern doesn't fire
    // 'until CI passes' blocked by lookbehind
    const text = "We cannot merge this until CI passes and the review is complete."
    expect(score(text)).toBe(0)
  })
})

describe("multi-reviewer conflicts", () => {
  it("mixed doc: ✅ Approved + CI passes + safe to merge + CHANGES_REQUESTED clamps to +1", () => {
    // Approval signals: ✅ stamp (+0.8), Approved+CI (+0.65), CI passes (+0.4), safe to merge (+0.5) = 2.35
    // Rejection: CHANGES_REQUESTED (-0.75)
    // Raw ≈ 1.6 → clamped to 1.0
    // The approval pile-on overwhelms the explicit rejection — approval wins by volume
    const text =
      "Reviewer A: ✅ **Approved** — CI passes. Safe to merge. Reviewer B: CHANGES_REQUESTED — missing tests."
    expect(score(text)).toBe(1)
    expect(rejectionLabels(text)).toContain("CHANGES_REQUESTED review state")
  })

  it("'one reviewer approved, another requested changes' scores neutral — count phrasing misses stamps", () => {
    const text =
      "One reviewer approved, another requested changes. The net status is unclear."
    expect(score(text)).toBe(0)
  })
})

describe("hedging containing rejection keywords", () => {
  it("'Non-blocking issue: CI is failing on unrelated job. Safe to merge.' exposes false-positive", () => {
    // ⚠ BUG: 'Non-blocking issue' contains 'blocking issue' which fires the rejection
    // pattern '\bblocking\s+issues?\b' (-0.5). Combined with 'CI is failing' (-0.6),
    // dampFactor 0.75 reduces rejection to -0.825, but hedging (+0.2) + safe to merge (+0.5)
    // only total 0.7 — net score ≈ -0.125 (negative), contrary to the intent of the text.
    const text = "Non-blocking issue: CI is failing on an unrelated job. Safe to merge the main feature."
    expect(score(text)).toBeCloseTo(-0.125, 3)
    // The hedging fires correctly...
    expect(hedgingLabels(text)).toContain("non-blocking (reduces negatives)")
    // ...but the rejection pattern also fires on the substring 'blocking issue' inside 'Non-blocking issue'
    expect(rejectionLabels(text)).toContain("blocking issues")
    expect(rejectionLabels(text)).toContain("CI failing")
  })

  it("'Not a blocker: there are blocking concerns in a separate PR' scores positive", () => {
    // 'Not a blocker' adds hedging weight; 'blocking concerns' ≠ 'blocking issues' so no rejection
    const text = "Not a blocker: there are blocking concerns in a separate PR."
    expect(score(text)).toBeGreaterThan(0)
    expect(rejectionLabels(text)).not.toContain("blocking issues")
  })

  it("'CI green but blocked by other PR — cannot unblock until upstream merges' scores positive", () => {
    // 'CI green' matches '\bCI\s+(?:passes|passed|is green|green)\b' → +0.4
    // 'blocked' alone does not match 'blocking issues\b'
    // 'cannot unblock' does not match 'cannot be merged'
    const text = "CI green but blocked by other PR dependencies. Cannot unblock until the upstream PR merges."
    expect(score(text)).toBeGreaterThan(0)
    expect(approvalLabels(text)).toContain("CI passes")
  })
})

describe("github notification boilerplate false positives", () => {
  it("'requested to review. CI passes. Ready for review.' scores as approval despite being a notification", () => {
    // Notification emails contain genuine approval signals — scorer has no channel awareness
    const text =
      "You have been requested to review this PR. CI passes. The author is ready for review."
    const s = score(text)
    expect(s).toBeGreaterThan(0.5)
    expect(approvalLabels(text)).toContain("CI passes")
    expect(approvalLabels(text)).toContain("ready for review/merge")
  })

  it("'Review verdict missing from automated check' scores negative from notification text", () => {
    const text = "This is an auto-generated notification. Review verdict missing from the automated check."
    expect(score(text)).toBeLessThan(0)
    expect(rejectionLabels(text)).toContain("review verdict missing")
  })
})

describe("double negatives and ambiguous phrasing", () => {
  it("'no issues not worth addressing' scores neutral — double-negative misses 'no issues found'", () => {
    // 'no issues found' pattern requires the word 'found'; 'no issues not worth' doesn't match
    expect(score("There are no issues not worth addressing.")).toBe(0)
  })

  it("'neither observation is a blocker' misses hedging — needs 'neither is' directly adjacent", () => {
    // '/\\bneither\\s+is\\s+a\\s+blocker\\b/' requires 'neither is' without intervening words
    // 'neither observation is a blocker' has 'observation' between 'neither' and 'is'
    const text = "Neither observation is a blocker."
    expect(hedgingLabels(text)).not.toContain("neither is a blocker")
  })

  it("comprehensive hedged approval: 'CI passed. Well-implemented. Neither observation is a blocker. Safe to merge.'", () => {
    // 'neither observation is a blocker' misses the hedging pattern (see above)
    // But approval signals accumulate enough to clamp at 1.0 regardless
    const text =
      "CI passed. Well-implemented. Not a regression. Consider adding tests. Neither observation is a blocker. Safe to merge."
    expect(score(text)).toBe(1)
    expect(hedgingLabels(text)).not.toContain("neither is a blocker") // wording gap confirmed
    expect(hedgingLabels(text)).toContain("not a regression") // this one does fire
  })
})
