import { describe, expect, test } from "bun:test"
import { formatDuration, formatDurationPrecise } from "./format-duration.ts"

describe("formatDurationPrecise", () => {
  test("formats sub-minute durations in seconds", () => {
    expect(formatDurationPrecise(45_000)).toBe("45s")
  })

  test("keeps fractional seconds to one decimal place", () => {
    expect(formatDurationPrecise(1_500)).toBe("1.5s")
  })

  test("drops trailing zero decimals", () => {
    expect(formatDurationPrecise(2_001)).toBe("2s")
  })

  test("formats whole minutes without a seconds part", () => {
    expect(formatDurationPrecise(120_000)).toBe("2m")
  })

  test("formats minutes with a seconds remainder", () => {
    expect(formatDurationPrecise(130_000)).toBe("2m 10s")
  })

  test("keeps fractional remainder seconds", () => {
    expect(formatDurationPrecise(90_500)).toBe("1m 30.5s")
  })

  test("formats a whole hour with no smaller parts", () => {
    expect(formatDurationPrecise(3_600_000)).toBe("1h")
  })

  test("formats hours with a minute remainder, dropping zero seconds", () => {
    expect(formatDurationPrecise(7_500_000)).toBe("2h 5m")
  })

  test("drops a zero-minute part but keeps fractional seconds", () => {
    expect(formatDurationPrecise(3_630_500)).toBe("1h 30.5s")
  })

  test("renders the full hour/minute/second form when all are present", () => {
    expect(formatDurationPrecise(3_661_000)).toBe("1h 1m 1s")
  })

  test("drops a zero-second part when hours and minutes are present", () => {
    expect(formatDurationPrecise(3_660_000)).toBe("1h 1m")
  })

  test("formats zero as 0s", () => {
    expect(formatDurationPrecise(0)).toBe("0s")
  })

  test("rounds up sub-minute-boundary durations to next tier instead of 60s", () => {
    expect(formatDurationPrecise(7_199_990)).toBe("2h")
  })
})

describe("formatDuration", () => {
  test("rounds sub-minute durations to whole seconds", () => {
    expect(formatDuration(1_500)).toBe("2s")
  })

  test("floors to whole minutes under an hour", () => {
    expect(formatDuration(130_000)).toBe("2m")
  })

  test("formats hours with minute remainder", () => {
    expect(formatDuration(3_661_000)).toBe("1h 1m")
  })

  test("formats days with hour remainder", () => {
    expect(formatDuration(90_061_000)).toBe("1d 1h")
  })
})
