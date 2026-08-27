import { describe, expect, test } from "bun:test"
import { calculateHookWallTimeMs, formatDiagnosticDuration } from "./dashboard-stats.tsx"

describe("calculateHookWallTimeMs", () => {
  test("uses the longer concurrent hook stage instead of adding overlapping stages", () => {
    expect(
      calculateHookWallTimeMs([
        {
          name: "preToolUse",
          count: 10,
          avgMs: 550,
          routes: {
            preToolUse: {
              count: 10,
              stages: {
                syncHooks: { count: 10, avgMs: 500 },
                asyncHooks: { count: 10, avgMs: 350 },
              },
            },
          },
        },
      ])
    ).toBe(500)
  })

  test("weights hook stages by their actual sample count", () => {
    expect(
      calculateHookWallTimeMs([
        {
          name: "postToolUse",
          count: 10,
          avgMs: 150,
          routes: {
            blocking: {
              count: 10,
              stages: { syncHooks: { count: 4, avgMs: 200 } },
            },
          },
        },
      ])
    ).toBe(80)
  })

  test("returns zero when no project dispatches exist", () => {
    expect(calculateHookWallTimeMs([])).toBe(0)
  })
})

describe("formatDiagnosticDuration", () => {
  test("distinguishes missing monitor samples from genuine measurements", () => {
    expect(formatDiagnosticDuration(undefined, 0)).toBe("Not recorded")
    expect(formatDiagnosticDuration(0, 6)).toBe("<1 ms")
  })

  test("preserves sub-millisecond precision instead of displaying zero", () => {
    expect(formatDiagnosticDuration(0.25, 6)).toBe("0.25 ms")
    expect(formatDiagnosticDuration(0.5, 6)).toBe("0.5 ms")
  })

  test("rounds ordinary millisecond durations", () => {
    expect(formatDiagnosticDuration(14.7, 3)).toBe("15 ms")
  })
})
