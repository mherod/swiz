import { describe, expect, test } from "bun:test"
import { preCompactHookInputSchema, sessionHookInputSchema } from "../schemas.ts"
import {
  assertNormalizedDispatchPayload,
  DispatchPayloadValidationError,
} from "./dispatch-zod-surfaces.ts"

/** Shape Claude Code sends on `/compact`, minus the fields under test. */
const CLAUDE_PRECOMPACT_BASE = {
  session_id: "7ed7644d-3b7c-4d02-8278-9aa2d4059950",
  transcript_path: "/tmp/transcript.jsonl",
  cwd: "/Users/tester/Development/swiz",
  hook_event_name: "PreCompact",
}

describe("preCompact dispatch payload", () => {
  test("accepts a null custom_instructions", () => {
    const payload = { ...CLAUDE_PRECOMPACT_BASE, trigger: "manual", custom_instructions: null }

    // Control: the package-derived schema this route used to union over rejects the same
    // payload, so the acceptance above is real tolerance and not a vacuous pass.
    expect(sessionHookInputSchema.safeParse(payload).success).toBe(false)
    expect(preCompactHookInputSchema.safeParse(payload).success).toBe(true)
    expect(assertNormalizedDispatchPayload("preCompact", payload).session_id).toBe(
      CLAUDE_PRECOMPACT_BASE.session_id
    )
  })

  test("accepts a trigger outside the manual/auto enum", () => {
    const payload = { ...CLAUDE_PRECOMPACT_BASE, trigger: "compact" }

    expect(sessionHookInputSchema.safeParse(payload).success).toBe(false)
    expect(preCompactHookInputSchema.safeParse(payload).success).toBe(true)
  })

  test("accepts the Gemini PreCompress shape", () => {
    const payload = {
      session_id: "gemini-session",
      cwd: "/Users/tester/Development/swiz",
      hook_event_name: "PreCompress",
    }

    expect(preCompactHookInputSchema.safeParse(payload).success).toBe(true)
  })

  test("still rejects a payload whose typed field has the wrong type", () => {
    expect(() =>
      assertNormalizedDispatchPayload("preCompact", { ...CLAUDE_PRECOMPACT_BASE, session_id: 42 })
    ).toThrow(DispatchPayloadValidationError)
  })
})

describe("DispatchPayloadValidationError", () => {
  test("names the offending field in the message", () => {
    let message = ""
    try {
      assertNormalizedDispatchPayload("preCompact", { ...CLAUDE_PRECOMPACT_BASE, trigger: 7 })
    } catch (err) {
      message = (err as Error).message
    }

    expect(message).toContain('Invalid dispatch payload for event "preCompact"')
    expect(message).toContain("trigger")
  })
})
