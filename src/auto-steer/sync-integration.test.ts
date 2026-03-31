import { beforeEach, describe, expect, it } from "bun:test"
import type { UpstreamSyncResult } from "../issue-store.ts"
import { type AutoSteerPayload, resetPrTrackerState } from "./pr-review-tracker.ts"
import {
  createSyncIntegrationContext,
  processSyncForAutoSteer,
  type SyncIntegrationContext,
} from "./sync-integration.ts"

describe("Sync Integration", () => {
  let mockResult: UpstreamSyncResult
  let payloadsCollected: AutoSteerPayload[] = []

  beforeEach(() => {
    resetPrTrackerState()
    payloadsCollected = []
    mockResult = {
      issues: { upserted: 0, removed: 0, skipped: 0, changes: [] },
      pullRequests: { upserted: 0, removed: 0, skipped: 0, changes: [] },
      ciStatuses: { upserted: 0, changes: [] },
      comments: { upserted: 0 },
      labels: { upserted: 0, removed: 0, skipped: 0, changes: [] },
      milestones: { upserted: 0, removed: 0, skipped: 0, changes: [] },
      branchCi: { upserted: 0, changes: [] },
      prBranchDetail: {
        upserted: 1,
        changes: [
          {
            kind: "updated",
            key: "main",
            reason: "review/comments changed",
          },
        ],
      },
      branchProtection: { upserted: 0, changes: [] },
    }
  })

  describe("processSyncForAutoSteer", () => {
    it("processes review transitions when enabled", () => {
      const ctx: SyncIntegrationContext = {
        enabled: true,
        enqueueAutoSteer: (payloads) => {
          payloadsCollected.push(...payloads)
        },
      }

      processSyncForAutoSteer(mockResult, [{ number: 1, reviewDecision: "APPROVED" }], [], ctx)

      expect(payloadsCollected.length).toBeGreaterThanOrEqual(1)
      if (payloadsCollected[0]) {
        expect(payloadsCollected[0]).toHaveProperty("type", "PR_APPROVAL")
      }
    })

    it("skips processing when disabled", () => {
      const ctx: SyncIntegrationContext = {
        enabled: false,
        enqueueAutoSteer: (payloads) => {
          payloadsCollected.push(...payloads)
        },
      }

      processSyncForAutoSteer(mockResult, [{ number: 1, reviewDecision: "APPROVED" }], [], ctx)

      expect(payloadsCollected).toHaveLength(0)
    })

    it("skips when no PR branch detail changes", () => {
      const result: UpstreamSyncResult = {
        ...mockResult,
        prBranchDetail: { upserted: 0, changes: [] },
      }

      const ctx: SyncIntegrationContext = {
        enabled: true,
        enqueueAutoSteer: () => {},
      }

      processSyncForAutoSteer(result, [{ number: 1, reviewDecision: "APPROVED" }], [], ctx)

      expect(payloadsCollected).toHaveLength(0)
    })

    it("collects multiple payloads", () => {
      const ctx: SyncIntegrationContext = {
        enabled: true,
        enqueueAutoSteer: (payloads) => {
          payloadsCollected.push(...payloads)
        },
      }

      processSyncForAutoSteer(
        mockResult,
        [
          { number: 1, reviewDecision: "APPROVED" },
          { number: 2, reviewDecision: "CHANGES_REQUESTED" },
        ],
        [],
        ctx
      )

      expect(payloadsCollected).toHaveLength(2)
    })
  })

  describe("createSyncIntegrationContext", () => {
    it("enables when both sessionId and autoSteerEnabled are true", () => {
      const ctx = createSyncIntegrationContext("session-123", true, () => {})
      expect(ctx.enabled).toBe(true)
    })

    it("disables when sessionId is missing", () => {
      const ctx = createSyncIntegrationContext(undefined, true, () => {})
      expect(ctx.enabled).toBe(false)
    })

    it("disables when autoSteerEnabled is false", () => {
      const ctx = createSyncIntegrationContext("session-123", false, () => {})
      expect(ctx.enabled).toBe(false)
    })

    it("calls callback when payloads are enqueued", () => {
      const called: boolean[] = []
      const ctx = createSyncIntegrationContext("session-123", true, (payloads) => {
        called.push(payloads.length > 0)
      })

      ctx.enqueueAutoSteer([
        {
          type: "PR_APPROVAL",
          prNumber: 1,
          message: "Approved",
          timestamp: new Date().toISOString(),
          priority: "normal",
        },
      ])

      expect(called).toHaveLength(1)
      expect(called[0]).toBe(true)
    })

    it("skips callback for empty payloads", () => {
      let callCount = 0
      const ctx = createSyncIntegrationContext("session-123", true, () => {
        callCount++
      })

      ctx.enqueueAutoSteer([])

      expect(callCount).toBe(0)
    })
  })
})
