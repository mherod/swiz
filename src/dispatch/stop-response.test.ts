import { afterEach, describe, expect, test } from "bun:test"
import { stopHookOutputSchema } from "../schemas.ts"
import {
  compileStopReasons,
  DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT,
  normalizeStopDispatchResponseInPlace,
} from "./stop-response.ts"

describe("normalizeStopDispatchResponseInPlace", () => {
  test("coerces empty object to a stopHookOutputSchema-valid envelope", () => {
    const r: Record<string, any> = {}
    normalizeStopDispatchResponseInPlace(r, "Stop")
    expect(r.continue).toBe(true)
    expect(stopHookOutputSchema.safeParse(r).success).toBe(true)
    expect(r.hookSpecificOutput).toBeUndefined()
    expect(r.reason).toBe(DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT)
    expect(r.stopReason).toBe(DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT)
  })

  test("replaces continue: false with true when context is present", () => {
    const r: Record<string, any> = {
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
    const r: Record<string, any> = {
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

describe("compileStopReasons", () => {
  const savedEnv: Record<string, string | undefined> = {}

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  test("returns single reason unchanged (no LLM call)", async () => {
    const single = "Uncommitted changes detected."
    const result = await compileStopReasons(single)
    expect(result).toBe(single)
  })

  test("returns raw reason unchanged when parts <= 1", async () => {
    const raw = "One blocker only"
    expect(await compileStopReasons(raw)).toBe(raw)
  })

  test("falls back to raw reason when OPENROUTER_API_KEY is unset", async () => {
    savedEnv.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
    delete process.env.OPENROUTER_API_KEY

    const raw = "Reason A\n\n\n\nReason B"
    const result = await compileStopReasons(raw)
    expect(result).toBe(raw)
  })
})
