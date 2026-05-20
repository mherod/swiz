import { describe, expect, test } from "bun:test"
import {
  COMPLIANCE_SUPPRESS_THRESHOLD_MS,
  isComplianceSuppressible,
} from "./pretooluse-task-governance.ts"

describe("isComplianceSuppressible", () => {
  test("returns false for null entry", () => {
    expect(isComplianceSuppressible(null)).toBe(false)
  })

  test("returns false when state is unhealthy", () => {
    const now = Date.now()
    expect(isComplianceSuppressible({ state: "unhealthy", at: now - 60_000 }, now)).toBe(false)
  })

  test("returns false when healthy for less than threshold", () => {
    const now = Date.now()
    expect(
      isComplianceSuppressible(
        { state: "healthy", at: now - COMPLIANCE_SUPPRESS_THRESHOLD_MS + 1 },
        now
      )
    ).toBe(false)
  })

  test("returns false when healthy for exactly one millisecond under threshold", () => {
    const now = Date.now()
    expect(
      isComplianceSuppressible(
        { state: "healthy", at: now - (COMPLIANCE_SUPPRESS_THRESHOLD_MS - 1) },
        now
      )
    ).toBe(false)
  })

  test("returns true when healthy for exactly the threshold", () => {
    const now = Date.now()
    expect(
      isComplianceSuppressible(
        { state: "healthy", at: now - COMPLIANCE_SUPPRESS_THRESHOLD_MS },
        now
      )
    ).toBe(true)
  })

  test("returns true when healthy for more than threshold", () => {
    const now = Date.now()
    expect(isComplianceSuppressible({ state: "healthy", at: now - 60_000 }, now)).toBe(true)
  })

  test("returns true when healthy for much longer than threshold", () => {
    const now = Date.now()
    expect(isComplianceSuppressible({ state: "healthy", at: now - 5 * 60_000 }, now)).toBe(true)
  })
})
