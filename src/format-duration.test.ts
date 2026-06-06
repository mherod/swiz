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

  test("formats zero as 0s", () => {
    expect(formatDurationPrecise(0)).toBe("0s")
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
