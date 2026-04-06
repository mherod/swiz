import { describe, expect, test } from "bun:test"
import type { StopHookInput } from "../src/schemas.ts"
import { evaluateStopPrFeedback } from "./stop-pr-feedback/evaluate.ts"
import { partitionPRsForStop } from "./stop-pr-feedback/pull-requests.ts"
import type { PR } from "./stop-pr-feedback/types.ts"

describe("stop-pr-feedback hook", () => {
  describe("partitionPRsForStop", () => {
    test("categorizes PRs by review decision and merge status", () => {
      const prs: PR[] = [
        {
          number: 1,
          title: "Changes requested",
          url: "https://github.com/user/repo/pull/1",
          reviewDecision: "CHANGES_REQUESTED",
          mergeable: "MERGEABLE",
        },
        {
          number: 2,
          title: "Needs review",
          url: "https://github.com/user/repo/pull/2",
          reviewDecision: "REVIEW_REQUIRED",
          mergeable: "MERGEABLE",
        },
        {
          number: 3,
          title: "Has merge conflict",
          url: "https://github.com/user/repo/pull/3",
          reviewDecision: "APPROVED",
          mergeable: "CONFLICTING",
        },
        {
          number: 4,
          title: "Approved and mergeable",
          url: "https://github.com/user/repo/pull/4",
          reviewDecision: "APPROVED",
          mergeable: "MERGEABLE",
        },
      ]

      const result = partitionPRsForStop(prs)

      expect(result.changesRequestedPRs).toHaveLength(1)
      expect(result.changesRequestedPRs[0]?.number).toBe(1)

      expect(result.reviewRequiredPRs).toHaveLength(1)
      expect(result.reviewRequiredPRs[0]?.number).toBe(2)

      expect(result.conflictingPRs).toHaveLength(1)
      expect(result.conflictingPRs[0]?.number).toBe(3)
    })

    test("ignores approved, mergeable PRs", () => {
      const prs: PR[] = [
        {
          number: 1,
          title: "Ready to merge",
          url: "https://github.com/user/repo/pull/1",
          reviewDecision: "APPROVED",
          mergeable: "MERGEABLE",
        },
      ]

      const result = partitionPRsForStop(prs)

      expect(result.changesRequestedPRs).toHaveLength(0)
      expect(result.reviewRequiredPRs).toHaveLength(0)
      expect(result.conflictingPRs).toHaveLength(0)
    })

    test("handles PR with both changes requested AND conflict", () => {
      const prs: PR[] = [
        {
          number: 1,
          title: "Both issues",
          url: "https://github.com/user/repo/pull/1",
          reviewDecision: "CHANGES_REQUESTED",
          mergeable: "CONFLICTING",
        },
      ]

      const result = partitionPRsForStop(prs)

      expect(result.changesRequestedPRs).toHaveLength(1)
      expect(result.conflictingPRs).toHaveLength(1)
    })
  })

  describe("evaluateStopPrFeedback", () => {
    test("returns empty object when no PRs need attention", async () => {
      const input: Partial<StopHookInput> = {
        cwd: "/tmp",
        session_id: "test",
      }

      const result = await evaluateStopPrFeedback(input as StopHookInput)
      expect(result).toBeDefined()
    })

    test("hook handles missing context gracefully", async () => {
      const input: StopHookInput = {
        cwd: "",
        session_id: undefined,
      }

      const result = await evaluateStopPrFeedback(input)
      expect(result).toEqual({})
    })
  })

  describe("PR feedback categorization", () => {
    test("generates correct priority ordering for PR feedback", () => {
      const changesRequested: PR[] = [
        {
          number: 1,
          title: "Must fix",
          url: "https://github.com/user/repo/pull/1",
          reviewDecision: "CHANGES_REQUESTED",
          mergeable: "MERGEABLE",
        },
      ]

      const reviewRequired: PR[] = [
        {
          number: 2,
          title: "Awaiting review",
          url: "https://github.com/user/repo/pull/2",
          reviewDecision: "REVIEW_REQUIRED",
          mergeable: "MERGEABLE",
        },
      ]

      const allPRs = [...changesRequested, ...reviewRequired]
      const result = partitionPRsForStop(allPRs)

      expect(result.changesRequestedPRs).toHaveLength(1)
      expect(result.reviewRequiredPRs).toHaveLength(1)
    })
  })

  describe("merge conflict detection", () => {
    test("identifies PRs with merge conflicts", () => {
      const conflicting: PR[] = [
        {
          number: 1,
          title: "Conflicted",
          url: "https://github.com/user/repo/pull/1",
          reviewDecision: "REVIEW_REQUIRED",
          mergeable: "CONFLICTING",
        },
      ]

      const result = partitionPRsForStop(conflicting)
      expect(result.conflictingPRs).toHaveLength(1)
      expect(result.conflictingPRs[0]?.mergeable).toBe("CONFLICTING")
    })

    test("ignores unknown merge status", () => {
      const unknown: PR[] = [
        {
          number: 1,
          title: "Still computing",
          url: "https://github.com/user/repo/pull/1",
          reviewDecision: "REVIEW_REQUIRED",
          mergeable: "UNKNOWN",
        },
      ]

      const result = partitionPRsForStop(unknown)
      expect(result.conflictingPRs).toHaveLength(0)
    })
  })
})
