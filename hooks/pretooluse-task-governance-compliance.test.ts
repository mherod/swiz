import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  COMPLIANCE_SUPPRESS_THRESHOLD_MS,
  isComplianceSuppressible,
  shouldSuppressGovernanceTrace,
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

describe("shouldSuppressGovernanceTrace", () => {
  let originalFetch: typeof global.fetch

  beforeAll(() => {
    originalFetch = global.fetch
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  function mockFetchCompliance(responseBody: any, ok = true) {
    global.fetch = (() => {
      return Promise.resolve({
        ok,
        json: () => Promise.resolve(responseBody),
      } as Response)
    }) as any
  }

  test("returns false when session ID is missing", async () => {
    const result = await shouldSuppressGovernanceTrace({})
    expect(result).toBe(false)
  })

  test("returns true immediately for code change tools when task governance is healthy", async () => {
    mockFetchCompliance({
      current: {
        state: "healthy",
        at: Date.now() - 5000, // less than COMPLIANCE_SUPPRESS_THRESHOLD_MS (30s)
      },
    })
    const result = await shouldSuppressGovernanceTrace({
      session_id: "test-sess",
      tool_name: "Edit",
    })
    expect(result).toBe(true)
  })

  test("returns true immediately for task update tools when task governance is healthy", async () => {
    mockFetchCompliance({
      current: {
        state: "healthy",
        at: Date.now() - 5000,
      },
    })
    const result = await shouldSuppressGovernanceTrace({
      session_id: "test-sess",
      tool_name: "TaskUpdate",
    })
    expect(result).toBe(true)
  })

  test("returns false for non-code-change and non-task-update tools when healthy for less than threshold", async () => {
    mockFetchCompliance({
      current: {
        state: "healthy",
        at: Date.now() - 5000,
      },
    })
    const result = await shouldSuppressGovernanceTrace({
      session_id: "test-sess",
      tool_name: "TaskList",
    })
    expect(result).toBe(false)
  })

  test("returns true for non-code-change tools when healthy for longer than threshold", async () => {
    mockFetchCompliance({
      current: {
        state: "healthy",
        at: Date.now() - COMPLIANCE_SUPPRESS_THRESHOLD_MS - 5000,
      },
    })
    const result = await shouldSuppressGovernanceTrace({
      session_id: "test-sess",
      tool_name: "TaskList",
    })
    expect(result).toBe(true)
  })

  test("returns false when task governance is unhealthy", async () => {
    mockFetchCompliance({
      current: {
        state: "unhealthy",
        at: Date.now() - 60000,
      },
    })
    const result = await shouldSuppressGovernanceTrace({
      session_id: "test-sess",
      tool_name: "Edit",
    })
    expect(result).toBe(false)
  })
})
