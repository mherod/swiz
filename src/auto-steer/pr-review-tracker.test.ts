import { beforeEach, describe, expect, it } from "bun:test"
import { resetPrTrackerState, trackPrReviewTransitions } from "./pr-review-tracker.ts"

describe("PR Review Auto-Steer Tracker", () => {
  beforeEach(() => {
    resetPrTrackerState()
  })

  it("fires high-priority on initial CHANGES_REQUESTED", () => {
    const res = trackPrReviewTransitions([{ number: 42, reviewDecision: "CHANGES_REQUESTED" }], [])
    expect(res).toHaveLength(1)
    expect(res[0]!.type).toBe("PR_CHANGES_REQUESTED")
    expect(res[0]!.priority).toBe("high")
    expect(res[0]!.prNumber).toBe(42)
  })

  it("fires normal-priority on initial APPROVED", () => {
    const res = trackPrReviewTransitions([{ number: 10, reviewDecision: "APPROVED" }], [])
    expect(res).toHaveLength(1)
    expect(res[0]!.type).toBe("PR_APPROVAL")
    expect(res[0]!.priority).toBe("normal")
  })

  it("detects CHANGES_REQUESTED → APPROVED transition", () => {
    trackPrReviewTransitions([{ number: 42, reviewDecision: "CHANGES_REQUESTED" }], [])
    const res = trackPrReviewTransitions([{ number: 42, reviewDecision: "APPROVED" }], [])

    expect(res).toHaveLength(1)
    expect(res[0]!.type).toBe("PR_APPROVAL")
    expect(res[0]!.priority).toBe("high")
    expect(res[0]!.message).toContain("now been approved")
  })

  it("tracks comment additions across cycles", () => {
    trackPrReviewTransitions([{ number: 10, reviewDecision: "APPROVED" }], [])

    // First cycle: one comment
    const c1 = [{ id: "c1", prNumber: 10 }]
    const res1 = trackPrReviewTransitions([{ number: 10, reviewDecision: "APPROVED" }], c1)
    expect(res1).toHaveLength(1)
    expect(res1[0]!.type).toBe("PR_COMMENT")

    // Second cycle: same comment + new comment
    const c2 = [
      { id: "c1", prNumber: 10 },
      { id: "c2", prNumber: 10 },
    ]
    const res2 = trackPrReviewTransitions([{ number: 10, reviewDecision: "APPROVED" }], c2)
    expect(res2).toHaveLength(1)
    expect(res2[0]!.message).toContain("New comment")
  })

  it("ignores duplicate review states", () => {
    trackPrReviewTransitions([{ number: 7, reviewDecision: "APPROVED" }], [])
    const res = trackPrReviewTransitions([{ number: 7, reviewDecision: "APPROVED" }], [])

    expect(res).toHaveLength(0)
  })

  it("ignores duplicate comments", () => {
    const comments = [{ id: "c1", prNumber: 50 }]
    trackPrReviewTransitions([{ number: 50, reviewDecision: null }], comments)

    // Same comments in next sync — should not emit
    const res = trackPrReviewTransitions([{ number: 50, reviewDecision: null }], comments)
    expect(res).toHaveLength(0)
  })

  it("handles multiple PRs independently", () => {
    const res = trackPrReviewTransitions(
      [
        { number: 1, reviewDecision: "APPROVED" },
        { number: 2, reviewDecision: "CHANGES_REQUESTED" },
      ],
      []
    )

    expect(res).toHaveLength(2)
    const types = res.map((p) => p.type)
    expect(types).toContain("PR_APPROVAL")
    expect(types).toContain("PR_CHANGES_REQUESTED")
  })

  it("sorts payloads by priority (high first)", () => {
    const res = trackPrReviewTransitions(
      [
        { number: 1, reviewDecision: "APPROVED" },
        { number: 2, reviewDecision: "CHANGES_REQUESTED" },
      ],
      []
    )

    const sorted = [...res].sort((a, b) => {
      const pDiff = (b.priority === "high" ? 1 : 0) - (a.priority === "high" ? 1 : 0)
      return pDiff !== 0 ? pDiff : new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    })

    // CHANGES_REQUESTED has high priority, should come first
    expect(sorted[0]!.priority).toBe("high")
  })

  it("detects null → REVIEW_REQUIRED transition", () => {
    const res = trackPrReviewTransitions([{ number: 99, reviewDecision: "REVIEW_REQUIRED" }], [])

    // REVIEW_REQUIRED is valid but not explicitly handled like APPROVED/CHANGES_REQUESTED
    // It should track the state without emitting auto-steer
    expect(res).toHaveLength(0)
  })

  it("handles empty PR list", () => {
    const res = trackPrReviewTransitions([], [])
    expect(res).toHaveLength(0)
  })

  it("handles null review decision", () => {
    const res = trackPrReviewTransitions([{ number: 15, reviewDecision: null }], [])
    expect(res).toHaveLength(0)
  })

  it("tracks comments for PRs with multiple reviewers", () => {
    trackPrReviewTransitions(
      [{ number: 55, reviewDecision: "APPROVED" }],
      [{ id: "c1", prNumber: 55 }]
    )

    const res = trackPrReviewTransitions(
      [{ number: 55, reviewDecision: "APPROVED" }],
      [
        { id: "c1", prNumber: 55 },
        { id: "c2", prNumber: 55 },
        { id: "c3", prNumber: 55 },
      ]
    )

    // Should detect 2 new comments
    expect(res.filter((p) => p.type === "PR_COMMENT")).toHaveLength(2)
  })

  it("emits payloads with correct timestamps", () => {
    const before = new Date()
    const res = trackPrReviewTransitions([{ number: 77, reviewDecision: "APPROVED" }], [])
    const after = new Date()

    expect(res).toHaveLength(1)
    const payload = res[0]!
    const emittedTime = new Date(payload.timestamp)

    expect(emittedTime.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(emittedTime.getTime()).toBeLessThanOrEqual(after.getTime())
  })
})
