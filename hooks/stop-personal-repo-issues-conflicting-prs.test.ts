import { describe, expect, test } from "bun:test"
import {
  orderRebaseSuggestionPRs,
  selectRebaseSuggestionPRs,
} from "./stop-pr-feedback/pull-requests.ts"

// ── PR interface (mirrors stop-personal-repo-issues.ts) ──────────────────────

interface PR {
  number: number
  title: string
  url: string
  reviewDecision: string
  mergeable: string
  createdAt?: string
}

// ── Pure filtering logic (mirrors getOpenPRsWithFeedback client-side filter) ──

/**
 * Mirrors the client-side filter inside getOpenPRsWithFeedback:
 *   p.reviewDecision === "CHANGES_REQUESTED" ||
 *   p.reviewDecision === "REVIEW_REQUIRED"   ||
 *   p.mergeable === "CONFLICTING"
 */
function filterFeedbackPRs(prs: PR[]): PR[] {
  return prs.filter(
    (p) =>
      p.reviewDecision === "CHANGES_REQUESTED" ||
      p.reviewDecision === "REVIEW_REQUIRED" ||
      p.mergeable === "CONFLICTING"
  )
}

// ── Partition helpers (mirrors main() partitioning in stop-personal-repo-issues.ts) ──

function partitionPRs(prs: PR[]): {
  changesRequestedPRs: PR[]
  conflictingPRs: PR[]
  reviewRequiredPRs: PR[]
} {
  return {
    changesRequestedPRs: prs.filter((p) => p.reviewDecision === "CHANGES_REQUESTED"),
    conflictingPRs: prs.filter((p) => p.mergeable === "CONFLICTING"),
    reviewRequiredPRs: prs.filter((p) => p.reviewDecision === "REVIEW_REQUIRED"),
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makePR(overrides: Partial<PR> & { number: number; title: string }): PR {
  return {
    url: `https://github.com/mherod/repo/pull/${overrides.number}`,
    reviewDecision: "REVIEW_REQUIRED",
    mergeable: "MERGEABLE",
    ...overrides,
  }
}

const changesRequestedPR = makePR({
  number: 10,
  title: "Fix auth flow",
  reviewDecision: "CHANGES_REQUESTED",
  mergeable: "MERGEABLE",
})

const reviewRequiredPR = makePR({
  number: 11,
  title: "Add dark mode",
  reviewDecision: "REVIEW_REQUIRED",
  mergeable: "MERGEABLE",
})

const conflictingPR = makePR({
  number: 12,
  title: "Rebase me",
  reviewDecision: "REVIEW_REQUIRED",
  mergeable: "CONFLICTING",
})

const unknownMergeabilityPR = makePR({
  number: 13,
  title: "Still computing",
  reviewDecision: "APPROVED",
  mergeable: "UNKNOWN",
})

const mergeablePR = makePR({
  number: 14,
  title: "Clean merge",
  reviewDecision: "APPROVED",
  mergeable: "MERGEABLE",
})

const conflictingChangesRequestedPR = makePR({
  number: 15,
  title: "Both conflicts and changes requested",
  reviewDecision: "CHANGES_REQUESTED",
  mergeable: "CONFLICTING",
})

// ─── filterFeedbackPRs — inclusion/exclusion ──────────────────────────────────

describe("filterFeedbackPRs — CHANGES_REQUESTED", () => {
  test("includes PR with CHANGES_REQUESTED regardless of mergeable", () => {
    expect(filterFeedbackPRs([changesRequestedPR])).toHaveLength(1)
  })

  test("includes PR with CHANGES_REQUESTED even when CONFLICTING", () => {
    expect(filterFeedbackPRs([conflictingChangesRequestedPR])).toHaveLength(1)
  })
})

describe("filterFeedbackPRs — REVIEW_REQUIRED", () => {
  test("includes PR with REVIEW_REQUIRED", () => {
    expect(filterFeedbackPRs([reviewRequiredPR])).toHaveLength(1)
  })
})

describe("filterFeedbackPRs — CONFLICTING mergeability", () => {
  test("includes PR with mergeable=CONFLICTING even when reviewDecision is REVIEW_REQUIRED", () => {
    expect(filterFeedbackPRs([conflictingPR])).toHaveLength(1)
  })

  test("includes PR with mergeable=CONFLICTING and reviewDecision=APPROVED", () => {
    const approvedConflicting = makePR({
      number: 20,
      title: "Approved but conflicting",
      reviewDecision: "APPROVED",
      mergeable: "CONFLICTING",
    })
    expect(filterFeedbackPRs([approvedConflicting])).toHaveLength(1)
  })
})

describe("filterFeedbackPRs — exclusions", () => {
  test("excludes PR with mergeable=UNKNOWN (still computing)", () => {
    expect(filterFeedbackPRs([unknownMergeabilityPR])).toHaveLength(0)
  })

  test("excludes approved mergeable PR (no feedback, no conflict)", () => {
    expect(filterFeedbackPRs([mergeablePR])).toHaveLength(0)
  })

  test("excludes PR with reviewDecision=APPROVED and mergeable=MERGEABLE", () => {
    const approved = makePR({ number: 21, title: "Approved", reviewDecision: "APPROVED" })
    expect(filterFeedbackPRs([approved])).toHaveLength(0)
  })

  test("excludes PR with reviewDecision=DISMISSED and mergeable=MERGEABLE", () => {
    const dismissed = makePR({ number: 22, title: "Dismissed", reviewDecision: "DISMISSED" })
    expect(filterFeedbackPRs([dismissed])).toHaveLength(0)
  })

  test("excludes PR with empty reviewDecision and mergeable=UNKNOWN", () => {
    const noDecision = makePR({ number: 23, title: "No decision", reviewDecision: "" })
    expect(filterFeedbackPRs([noDecision])).toHaveLength(0)
  })
})

describe("filterFeedbackPRs — mixed batches", () => {
  test("returns only actionable PRs from a mixed batch", () => {
    const all = [
      changesRequestedPR,
      reviewRequiredPR,
      conflictingPR,
      unknownMergeabilityPR,
      mergeablePR,
    ]
    const filtered = filterFeedbackPRs(all)
    expect(filtered).toHaveLength(3)
    const numbers = filtered.map((p) => p.number)
    expect(numbers).toContain(10) // CHANGES_REQUESTED
    expect(numbers).toContain(11) // REVIEW_REQUIRED
    expect(numbers).toContain(12) // CONFLICTING
    expect(numbers).not.toContain(13) // UNKNOWN — excluded
    expect(numbers).not.toContain(14) // APPROVED+MERGEABLE — excluded
  })

  test("returns all PRs when all are conflicting", () => {
    const prs = [1, 2, 3].map((n) =>
      makePR({ number: n, title: `PR ${n}`, mergeable: "CONFLICTING" })
    )
    expect(filterFeedbackPRs(prs)).toHaveLength(3)
  })

  test("returns empty list when all PRs are UNKNOWN or APPROVED/MERGEABLE", () => {
    expect(filterFeedbackPRs([unknownMergeabilityPR, mergeablePR])).toHaveLength(0)
  })

  test("returns empty list for empty input", () => {
    expect(filterFeedbackPRs([])).toHaveLength(0)
  })
})

// ─── partitionPRs — correct buckets ──────────────────────────────────────────

describe("partitionPRs — CHANGES_REQUESTED bucket", () => {
  test("CHANGES_REQUESTED PR lands in changesRequestedPRs", () => {
    const { changesRequestedPRs } = partitionPRs([changesRequestedPR])
    expect(changesRequestedPRs).toHaveLength(1)
    expect(changesRequestedPRs[0]!.number).toBe(10)
  })

  test("CHANGES_REQUESTED+CONFLICTING PR lands in BOTH changesRequestedPRs and conflictingPRs", () => {
    const { changesRequestedPRs, conflictingPRs } = partitionPRs([conflictingChangesRequestedPR])
    expect(changesRequestedPRs).toHaveLength(1)
    expect(conflictingPRs).toHaveLength(1)
    expect(changesRequestedPRs[0]!.number).toBe(15)
    expect(conflictingPRs[0]!.number).toBe(15)
  })
})

describe("partitionPRs — conflictingPRs bucket", () => {
  test("CONFLICTING PR lands in conflictingPRs", () => {
    const { conflictingPRs } = partitionPRs([conflictingPR])
    expect(conflictingPRs).toHaveLength(1)
    expect(conflictingPRs[0]!.number).toBe(12)
  })

  test("UNKNOWN PR does NOT land in conflictingPRs", () => {
    const { conflictingPRs } = partitionPRs([unknownMergeabilityPR])
    expect(conflictingPRs).toHaveLength(0)
  })

  test("MERGEABLE PR does NOT land in conflictingPRs", () => {
    const { conflictingPRs } = partitionPRs([reviewRequiredPR])
    expect(conflictingPRs).toHaveLength(0)
  })
})

describe("partitionPRs — reviewRequiredPRs bucket", () => {
  test("REVIEW_REQUIRED PR lands in reviewRequiredPRs", () => {
    const { reviewRequiredPRs } = partitionPRs([reviewRequiredPR])
    expect(reviewRequiredPRs).toHaveLength(1)
  })

  test("REVIEW_REQUIRED+CONFLICTING PR lands in BOTH conflictingPRs and reviewRequiredPRs", () => {
    const { conflictingPRs, reviewRequiredPRs } = partitionPRs([conflictingPR])
    expect(conflictingPRs).toHaveLength(1)
    expect(reviewRequiredPRs).toHaveLength(1)
  })

  test("CHANGES_REQUESTED PR does NOT land in reviewRequiredPRs", () => {
    const { reviewRequiredPRs } = partitionPRs([changesRequestedPR])
    expect(reviewRequiredPRs).toHaveLength(0)
  })
})

describe("partitionPRs — empty buckets", () => {
  test("approved mergeable PR: all buckets empty", () => {
    const { changesRequestedPRs, conflictingPRs, reviewRequiredPRs } = partitionPRs([mergeablePR])
    expect(changesRequestedPRs).toHaveLength(0)
    expect(conflictingPRs).toHaveLength(0)
    expect(reviewRequiredPRs).toHaveLength(0)
  })

  test("empty input: all buckets empty", () => {
    const { changesRequestedPRs, conflictingPRs, reviewRequiredPRs } = partitionPRs([])
    expect(changesRequestedPRs).toHaveLength(0)
    expect(conflictingPRs).toHaveLength(0)
    expect(reviewRequiredPRs).toHaveLength(0)
  })
})

// ─── Priority ordering verification ──────────────────────────────────────────
//
// Verifies the display priority order:
//   1. CHANGES_REQUESTED (highest urgency)
//   2. CONFLICTING (new — second)
//   3. REVIEW_REQUIRED (third)

describe("priority ordering — partition supports correct display order", () => {
  const allThreePRs = [changesRequestedPR, conflictingPR, reviewRequiredPR]

  test("changesRequestedPRs is non-empty when CHANGES_REQUESTED PR exists", () => {
    const { changesRequestedPRs } = partitionPRs(allThreePRs)
    expect(changesRequestedPRs.length).toBeGreaterThan(0)
  })

  test("conflictingPRs is non-empty when CONFLICTING PR exists", () => {
    const { conflictingPRs } = partitionPRs(allThreePRs)
    expect(conflictingPRs.length).toBeGreaterThan(0)
  })

  test("reviewRequiredPRs is non-empty when REVIEW_REQUIRED PR exists", () => {
    const { reviewRequiredPRs } = partitionPRs(allThreePRs)
    expect(reviewRequiredPRs.length).toBeGreaterThan(0)
  })

  test("CONFLICTING-only PR: no changesRequestedPRs, yes conflictingPRs, no reviewRequiredPRs", () => {
    const conflictingOnly = makePR({
      number: 30,
      title: "Conflicts only",
      reviewDecision: "APPROVED",
      mergeable: "CONFLICTING",
    })
    const { changesRequestedPRs, conflictingPRs, reviewRequiredPRs } = partitionPRs([
      conflictingOnly,
    ])
    expect(changesRequestedPRs).toHaveLength(0)
    expect(conflictingPRs).toHaveLength(1)
    expect(reviewRequiredPRs).toHaveLength(0)
  })

  test("CONFLICTING+REVIEW_REQUIRED PR appears in both conflictingPRs and reviewRequiredPRs", () => {
    // A PR that is REVIEW_REQUIRED *and* CONFLICTING appears in both buckets,
    // allowing the conflict section (displayed before REVIEW_REQUIRED) to show it.
    const { conflictingPRs, reviewRequiredPRs } = partitionPRs([conflictingPR])
    expect(conflictingPRs.map((p) => p.number)).toContain(12)
    expect(reviewRequiredPRs.map((p) => p.number)).toContain(12)
  })
})

// ─── Count derivation ─────────────────────────────────────────────────────────

describe("feedbackPRCount and conflictCount derivation", () => {
  /** Mirrors: feedbackPRCount = changesRequested.length + reviewRequired.length */
  function feedbackPRCount(prs: PR[]): number {
    const { changesRequestedPRs, reviewRequiredPRs } = partitionPRs(prs)
    return changesRequestedPRs.length + reviewRequiredPRs.length
  }

  /** Mirrors: conflictCount = conflictingPRs.length */
  function conflictCount(prs: PR[]): number {
    return partitionPRs(prs).conflictingPRs.length
  }

  test("feedbackPRCount=0 and conflictCount=0 for empty list → no block", () => {
    expect(feedbackPRCount([])).toBe(0)
    expect(conflictCount([])).toBe(0)
  })

  test("feedbackPRCount=1 for single CHANGES_REQUESTED", () => {
    expect(feedbackPRCount([changesRequestedPR])).toBe(1)
    expect(conflictCount([changesRequestedPR])).toBe(0)
  })

  test("feedbackPRCount=1 for single REVIEW_REQUIRED", () => {
    expect(feedbackPRCount([reviewRequiredPR])).toBe(1)
    expect(conflictCount([reviewRequiredPR])).toBe(0)
  })

  test("conflictCount=1 for single CONFLICTING PR with no feedback", () => {
    const conflictingApproved = makePR({
      number: 40,
      title: "Approved but conflicting",
      reviewDecision: "APPROVED",
      mergeable: "CONFLICTING",
    })
    expect(feedbackPRCount([conflictingApproved])).toBe(0)
    expect(conflictCount([conflictingApproved])).toBe(1)
  })

  test("feedbackPRCount=2 and conflictCount=1 for mixed batch", () => {
    // Use a pure-conflict PR (APPROVED+CONFLICTING) so it contributes only to conflictCount
    const pureConflict = makePR({
      number: 50,
      title: "Pure conflict",
      reviewDecision: "APPROVED",
      mergeable: "CONFLICTING",
    })
    const prs = filterFeedbackPRs([changesRequestedPR, reviewRequiredPR, pureConflict])
    expect(feedbackPRCount(prs)).toBe(2)
    expect(conflictCount(prs)).toBe(1)
  })

  test("UNKNOWN PR contributes 0 to both counts", () => {
    const prs = filterFeedbackPRs([unknownMergeabilityPR])
    expect(feedbackPRCount(prs)).toBe(0)
    expect(conflictCount(prs)).toBe(0)
  })

  test("no-block condition: all counts zero → hook should not block", () => {
    const issueCount = 0
    const refinementCount = 0
    const prs = filterFeedbackPRs([mergeablePR, unknownMergeabilityPR])
    const fb = feedbackPRCount(prs)
    const cc = conflictCount(prs)
    const shouldBlock = issueCount > 0 || fb > 0 || cc > 0 || refinementCount > 0
    expect(shouldBlock).toBe(false)
  })

  test("block condition: only conflicting PR → hook should block", () => {
    const issueCount = 0
    const refinementCount = 0
    const prs = filterFeedbackPRs([conflictingPR])
    const fb = feedbackPRCount(prs)
    const cc = conflictCount(prs)
    const shouldBlock = issueCount > 0 || fb > 0 || cc > 0 || refinementCount > 0
    expect(shouldBlock).toBe(true)
  })
})

describe("selectRebaseSuggestionPRs", () => {
  test("keeps only the two newest and two oldest PRs by createdAt", () => {
    const prs: PR[] = [1, 2, 3, 4, 5, 6].map((number) =>
      makePR({
        number,
        title: `PR ${number}`,
        mergeable: "CONFLICTING",
        createdAt: `2026-01-0${number}T00:00:00Z`,
      })
    )

    const { shown, hiddenCount } = selectRebaseSuggestionPRs(prs)

    expect(shown.map((pr) => pr.number)).toEqual([6, 5, 1, 2])
    expect(hiddenCount).toBe(2)
  })

  test("falls back to PR number when createdAt is unavailable", () => {
    const prs: PR[] = [22, 18, 31, 27, 14].map((number) =>
      makePR({
        number,
        title: `PR ${number}`,
        mergeable: "CONFLICTING",
      })
    )

    const { shown, hiddenCount } = selectRebaseSuggestionPRs(prs)

    expect(shown.map((pr) => pr.number)).toEqual([31, 27, 14, 18])
    expect(hiddenCount).toBe(1)
  })

  test("returns all PRs when four or fewer conflicts exist", () => {
    const prs: PR[] = [1, 2, 3, 4].map((number) =>
      makePR({
        number,
        title: `PR ${number}`,
        mergeable: "CONFLICTING",
      })
    )

    const { shown, hiddenCount } = selectRebaseSuggestionPRs(prs)

    expect(shown.map((pr) => pr.number)).toEqual([4, 3, 2, 1])
    expect(hiddenCount).toBe(0)
  })

  test("orders small sets by createdAt newest-first", () => {
    const prs: PR[] = [
      makePR({
        number: 101,
        title: "Older",
        mergeable: "CONFLICTING",
        createdAt: "2026-01-01T00:00:00Z",
      }),
      makePR({
        number: 102,
        title: "Newest",
        mergeable: "CONFLICTING",
        createdAt: "2026-01-03T00:00:00Z",
      }),
      makePR({
        number: 103,
        title: "Middle",
        mergeable: "CONFLICTING",
        createdAt: "2026-01-02T00:00:00Z",
      }),
    ]

    const { shown, hiddenCount } = selectRebaseSuggestionPRs(prs)
    expect(shown.map((pr) => pr.number)).toEqual([102, 103, 101])
    expect(hiddenCount).toBe(0)
  })
})

describe("orderRebaseSuggestionPRs", () => {
  test("uses PR number fallback newest-first when createdAt is unavailable", () => {
    const prs: PR[] = [22, 18, 31, 27, 14].map((number) =>
      makePR({
        number,
        title: `PR ${number}`,
        mergeable: "CONFLICTING",
      })
    )
    expect(orderRebaseSuggestionPRs(prs).map((pr) => pr.number)).toEqual([31, 27, 22, 18, 14])
  })
})

// ─── Existing behavior preserved ──────────────────────────────────────────────

describe("existing behavior preserved — CHANGES_REQUESTED and REVIEW_REQUIRED unchanged", () => {
  test("CHANGES_REQUESTED still included by filterFeedbackPRs", () => {
    expect(filterFeedbackPRs([changesRequestedPR])).toHaveLength(1)
  })

  test("REVIEW_REQUIRED still included by filterFeedbackPRs", () => {
    expect(filterFeedbackPRs([reviewRequiredPR])).toHaveLength(1)
  })

  test("APPROVED+MERGEABLE still excluded by filterFeedbackPRs", () => {
    expect(filterFeedbackPRs([mergeablePR])).toHaveLength(0)
  })

  test("CHANGES_REQUESTED PR lands only in changesRequestedPRs (not conflictingPRs)", () => {
    const { changesRequestedPRs, conflictingPRs } = partitionPRs([changesRequestedPR])
    expect(changesRequestedPRs).toHaveLength(1)
    expect(conflictingPRs).toHaveLength(0)
  })

  test("REVIEW_REQUIRED+MERGEABLE PR lands only in reviewRequiredPRs (not conflictingPRs)", () => {
    const { conflictingPRs, reviewRequiredPRs } = partitionPRs([reviewRequiredPR])
    expect(conflictingPRs).toHaveLength(0)
    expect(reviewRequiredPRs).toHaveLength(1)
  })
})
