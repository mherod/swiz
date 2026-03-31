import { beforeEach, describe, expect, it } from "bun:test"
import {
  flushPendingAutoSteers,
  processAutoSteerDirectives,
  type SessionAutoSteerContext,
} from "./session-lifecycle.ts"

describe("Session Auto-Steer Lifecycle", () => {
  let context: SessionAutoSteerContext

  beforeEach(() => {
    context = {
      autoSteerQueue: [],
      pendingDirectives: [],
      outputStream: undefined,
    }
  })

  describe("processAutoSteerDirectives", () => {
    it("injects directives and clears queue", () => {
      context.autoSteerQueue = [
        {
          type: "PR_COMMENT",
          prNumber: 1,
          message: "New comment",
          timestamp: new Date().toISOString(),
          priority: "normal",
        },
      ]

      processAutoSteerDirectives(context)

      expect(context.pendingDirectives).toHaveLength(1)
      expect(context.pendingDirectives[0]!).toContain("[AUTO-STEER")
      expect(context.pendingDirectives[0]!).toContain("PR #1")
      expect(context.pendingDirectives[0]!).toContain("New comment")
      expect(context.autoSteerQueue).toHaveLength(0)
    })

    it("sorts by priority (high first)", () => {
      const now = new Date()
      const later = new Date(now.getTime() + 1000)

      context.autoSteerQueue = [
        {
          type: "PR_COMMENT",
          prNumber: 1,
          message: "Comment",
          timestamp: later.toISOString(),
          priority: "normal",
        },
        {
          type: "PR_CHANGES_REQUESTED",
          prNumber: 2,
          message: "Changes requested",
          timestamp: now.toISOString(),
          priority: "high",
        },
      ]

      processAutoSteerDirectives(context)

      expect(context.pendingDirectives).toHaveLength(2)
      expect(context.pendingDirectives[0]!).toContain("PR #2")
      expect(context.pendingDirectives[1]!).toContain("PR #1")
    })

    it("handles empty queue gracefully", () => {
      processAutoSteerDirectives(context)

      expect(context.pendingDirectives).toHaveLength(0)
      expect(context.autoSteerQueue).toHaveLength(0)
    })

    it("formats message with proper spacing and details", () => {
      context.autoSteerQueue = [
        {
          type: "PR_APPROVAL",
          prNumber: 42,
          message: "PR was approved by reviewer",
          timestamp: new Date().toISOString(),
          priority: "normal",
        },
      ]

      processAutoSteerDirectives(context)

      const directive = context.pendingDirectives[0]!
      expect(directive).toContain("[AUTO-STEER")
      expect(directive).toContain("PR APPROVAL")
      expect(directive).toContain("PR #42")
      expect(directive).toContain("PR was approved by reviewer")
    })
  })

  describe("flushPendingAutoSteers", () => {
    it("writes payloads to output stream", () => {
      const output: string[] = []
      context.outputStream = {
        write: (text) => output.push(text),
      }
      context.autoSteerQueue = [
        {
          type: "PR_CHANGES_REQUESTED",
          prNumber: 10,
          message: "Changes needed",
          timestamp: new Date().toISOString(),
          priority: "high",
        },
      ]

      flushPendingAutoSteers(context)

      expect(output).toHaveLength(1)
      expect(output[0]!).toContain("PENDING AUTO-STEERS AT TERMINATION")
      expect(output[0]!).toContain("PR #10")
      expect(output[0]!).toContain("Changes needed")
      expect(context.autoSteerQueue).toHaveLength(0)
    })

    it("formats multiple payloads with bullets", () => {
      const output: string[] = []
      context.outputStream = {
        write: (text) => output.push(text),
      }
      context.autoSteerQueue = [
        {
          type: "PR_APPROVAL",
          prNumber: 1,
          message: "Approved",
          timestamp: new Date().toISOString(),
          priority: "normal",
        },
        {
          type: "PR_COMMENT",
          prNumber: 2,
          message: "New comment",
          timestamp: new Date().toISOString(),
          priority: "normal",
        },
      ]

      flushPendingAutoSteers(context)

      expect(output).toHaveLength(1)
      const text = output[0]!
      expect(text).toContain("•")
      expect(text).toContain("PR APPROVAL")
      expect(text).toContain("PR COMMENT")
    })

    it("handles missing output stream gracefully", () => {
      context.autoSteerQueue = [
        {
          type: "PR_COMMENT",
          prNumber: 5,
          message: "Comment",
          timestamp: new Date().toISOString(),
          priority: "normal",
        },
      ]

      expect(() => flushPendingAutoSteers(context)).not.toThrow()
      expect(context.autoSteerQueue).toHaveLength(0)
    })

    it("clears queue after flushing", () => {
      const output: string[] = []
      context.outputStream = {
        write: (text) => output.push(text),
      }
      context.autoSteerQueue = [
        {
          type: "PR_APPROVAL",
          prNumber: 99,
          message: "Test",
          timestamp: new Date().toISOString(),
          priority: "normal",
        },
      ]

      flushPendingAutoSteers(context)

      expect(context.autoSteerQueue).toHaveLength(0)
    })

    it("handles empty queue gracefully", () => {
      const output: string[] = []
      context.outputStream = {
        write: (text) => output.push(text),
      }

      flushPendingAutoSteers(context)

      expect(output).toHaveLength(0)
      expect(context.autoSteerQueue).toHaveLength(0)
    })
  })

  describe("Integration", () => {
    it("processes directives on turn then flushes on stop", () => {
      const turnDirectives: string[] = []
      const stopOutput: string[] = []

      context.outputStream = {
        write: (text) => stopOutput.push(text),
      }
      context.autoSteerQueue = [
        {
          type: "PR_APPROVAL",
          prNumber: 1,
          message: "Approved",
          timestamp: new Date().toISOString(),
          priority: "normal",
        },
        {
          type: "PR_COMMENT",
          prNumber: 2,
          message: "Comment",
          timestamp: new Date().toISOString(),
          priority: "normal",
        },
      ]

      // Simulate turn: process directives
      processAutoSteerDirectives(context)
      turnDirectives.push(...context.pendingDirectives)

      // Queue should be empty after processing
      expect(context.autoSteerQueue).toHaveLength(0)
      expect(turnDirectives).toHaveLength(2)

      // Add new payloads (from next sync)
      context.autoSteerQueue.push({
        type: "PR_CHANGES_REQUESTED",
        prNumber: 3,
        message: "Changes requested",
        timestamp: new Date().toISOString(),
        priority: "high",
      })

      // Simulate stop: flush remaining
      flushPendingAutoSteers(context)

      expect(stopOutput).toHaveLength(1)
      expect(stopOutput[0]!).toContain("PR #3")
      expect(context.autoSteerQueue).toHaveLength(0)
    })
  })
})
