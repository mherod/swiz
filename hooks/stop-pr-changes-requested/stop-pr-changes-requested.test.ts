/**
 * Tests for stop-pr-changes-requested hook extraction.
 *
 * Validates PR review state detection and blocking message formatting.
 */

import { describe, expect, it } from "bun:test"
import { buildChangesRequestedOutput, buildNoReviewsOutput } from "./action-plan.ts"
import { hasChangesRequested, hasNoReviews, isSelfAuthored } from "./review-validators.ts"
import type { PRCheckContext, Review } from "./types.ts"

const mockContext: PRCheckContext = {
  cwd: "/tmp/test-repo",
  sessionId: undefined,
  pr: { number: 42, title: "feat: add feature", author: { login: "testuser" } },
  repo: "user/repo",
  currentUser: "testuser",
}

const mockReviews: Review[] = [
  {
    state: "APPROVED",
    user: { login: "reviewer1" },
    body: "Looks good",
    submitted_at: "2026-04-05T10:00:00Z",
  },
  {
    state: "CHANGES_REQUESTED",
    user: { login: "reviewer2" },
    body: "Please fix spacing",
    submitted_at: "2026-04-05T11:00:00Z",
  },
]

describe("Review Validators", () => {
  it("detects self-authored PR", () => {
    expect(isSelfAuthored(mockContext.pr, "testuser")).toBe(true)
  })

  it("returns false for non-self-authored PR", () => {
    expect(isSelfAuthored(mockContext.pr, "otheruser")).toBe(false)
  })

  it("detects CHANGES_REQUESTED reviews", () => {
    const changesRequested = hasChangesRequested(mockReviews)
    expect(changesRequested).toHaveLength(1)
    expect(changesRequested[0]!.state).toBe("CHANGES_REQUESTED")
  })

  it("returns empty array when no CHANGES_REQUESTED", () => {
    const approvedOnly: Review[] = mockReviews.filter((r) => r.state === "APPROVED")
    const changesRequested = hasChangesRequested(approvedOnly)
    expect(changesRequested).toHaveLength(0)
  })

  it("detects no reviews", () => {
    expect(hasNoReviews([])).toBe(true)
  })

  it("returns false when reviews exist", () => {
    expect(hasNoReviews(mockReviews)).toBe(false)
  })
})

describe("Action Plan - Output Formatting", () => {
  it("formats no-reviews output for non-self-authored PR", async () => {
    const ctx: PRCheckContext = {
      ...mockContext,
      currentUser: "otheruser",
    }
    const output = await buildNoReviewsOutput(ctx.pr, ctx.repo, ctx.cwd, false)
    expect(output).toBeDefined()
    expect(JSON.stringify(output)).toContain("awaiting first review")
  })

  it("formats no-reviews output for self-authored PR", async () => {
    const output = await buildNoReviewsOutput(
      mockContext.pr,
      mockContext.repo,
      mockContext.cwd,
      true
    )
    expect(output).toBeDefined()
    expect(JSON.stringify(output)).toContain("awaiting first review")
  })

  it("formats changes-requested output", async () => {
    const changesRequested = hasChangesRequested(mockReviews)
    const output = await buildChangesRequestedOutput(
      mockContext.pr,
      changesRequested,
      [],
      [],
      mockContext.cwd
    )
    expect(output).toBeDefined()
    expect(JSON.stringify(output)).toContain("changes requested")
    expect(JSON.stringify(output)).toContain("reviewer2")
  })

  it("includes reviewer comments in output", async () => {
    const changesRequested = hasChangesRequested(mockReviews)
    const reviewComments = [
      {
        user: { login: "reviewer2" },
        body: "Line 42: This logic is confusing",
        path: "src/api.ts",
        created_at: "2026-04-05T11:30:00Z",
      },
    ]
    const output = await buildChangesRequestedOutput(
      mockContext.pr,
      changesRequested,
      reviewComments,
      [],
      mockContext.cwd
    )
    expect(JSON.stringify(output)).toContain("Line 42")
  })
})
