import { describe, expect, test } from "bun:test"
import { stopHookOutputSchema } from "../../hooks/schemas.ts"
import {
  DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT,
  normalizeStopDispatchResponseInPlace,
} from "./stop-response.ts"

describe("normalizeStopDispatchResponseInPlace", () => {
  test("coerces empty object to a stopHookOutputSchema-valid envelope", () => {
    const r: Record<string, unknown> = {}
    normalizeStopDispatchResponseInPlace(r, "Stop")
    expect(r.continue).toBe(true)
    expect(stopHookOutputSchema.safeParse(r).success).toBe(true)
    expect(r.hookSpecificOutput).toBeUndefined()
    expect(r.reason).toBe(DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT)
    expect(r.stopReason).toBe(DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT)
  })

  test("replaces continue: false with true when context is present", () => {
    const r: Record<string, unknown> = {
      continue: false,
      systemMessage: "ok",
      reason: "r",
    }
    normalizeStopDispatchResponseInPlace(r, "Stop")
    expect(r.continue).toBe(true)
    expect(r.stopReason).toBe("r")
    expect(stopHookOutputSchema.safeParse(r).success).toBe(true)
  })

  test("preserves stop hook block with stopReason — does not inject generic allow context", () => {
    const r: Record<string, unknown> = {
      continue: false,
      stopReason: "Uncommitted changes must be resolved before stopping.",
    }
    normalizeStopDispatchResponseInPlace(r, "Stop")
    expect(r.continue).toBe(true)
    expect(r.reason).toBe("Uncommitted changes must be resolved before stopping.")
    expect(r.hookSpecificOutput).toBeUndefined()
    expect(stopHookOutputSchema.safeParse(r).success).toBe(true)
    const hso = r.hookSpecificOutput as { additionalContext?: string } | undefined
    expect(hso?.additionalContext).not.toBe(DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT)
  })
})
