import { describe, expect, it } from "bun:test"
import { formatCoarseSessionAge, injectCoarseSessionAgeContext } from "./session-age-context.ts"

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

describe("formatCoarseSessionAge", () => {
  it.each([
    [0, "Session phase: opening (under about 15 minutes active)."],
    [15 * MINUTE_MS, "Session phase: underway (about 15-45 minutes active)."],
    [45 * MINUTE_MS, "Session phase: established (about 45-90 minutes active)."],
    [90 * MINUTE_MS, "Session phase: extended (about 1.5-3 hours active)."],
    [3 * HOUR_MS, "Session phase: long-running (over about 3 hours active)."],
  ])("maps %i milliseconds to a broad session phase", (elapsedMs, expected) => {
    expect(formatCoarseSessionAge(elapsedMs)).toBe(expected)
  })

  it("rejects invalid elapsed time", () => {
    expect(formatCoarseSessionAge(-1)).toBeNull()
    expect(formatCoarseSessionAge(Number.NaN)).toBeNull()
  })
})

describe("injectCoarseSessionAgeContext", () => {
  const nowMs = Date.parse("2026-08-08T12:00:00.000Z")

  it("appends the phase to existing tool context without exposing an exact stopwatch", () => {
    const response = {
      systemMessage: "Keep the change focused.",
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "Keep the change focused.",
      },
    }

    injectCoarseSessionAgeContext(
      response,
      "postToolUse",
      {},
      {
        nowMs,
        transcriptStartedAtMs: nowMs - 72 * MINUTE_MS,
      }
    )

    expect(response.systemMessage).toBe(
      "Keep the change focused.\n\nSession phase: established (about 45-90 minutes active)."
    )
    expect(response.hookSpecificOutput.additionalContext).toBe(response.systemMessage)
    expect(response.systemMessage).not.toContain("72")
  })

  it("falls back to transcript summary timing", () => {
    const response = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        additionalContext: "Task state is current.",
      },
    }

    injectCoarseSessionAgeContext(
      response,
      "preToolUse",
      {
        _transcriptSummary: {
          firstTimestamp: "2026-08-08T11:30:00.000Z",
          sessionDurationMs: 5 * MINUTE_MS,
        },
      },
      { nowMs }
    )

    expect(response.hookSpecificOutput.additionalContext).toContain(
      "Session phase: underway (about 15-45 minutes active)."
    )
  })

  it("does not add standalone noise or decorate non-tool events", () => {
    const emptyResponse: Record<string, unknown> = {}
    injectCoarseSessionAgeContext(
      emptyResponse,
      "postToolUse",
      {},
      {
        nowMs,
        transcriptStartedAtMs: nowMs - HOUR_MS,
      }
    )
    expect(emptyResponse).toEqual({})

    const sessionResponse = {
      systemMessage: "Project context.",
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "Project context.",
      },
    }
    injectCoarseSessionAgeContext(
      sessionResponse,
      "sessionStart",
      {},
      {
        nowMs,
        transcriptStartedAtMs: nowMs - HOUR_MS,
      }
    )
    expect(sessionResponse.hookSpecificOutput.additionalContext).toBe("Project context.")
  })
})
