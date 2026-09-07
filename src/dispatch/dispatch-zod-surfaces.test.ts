import { describe, expect, test } from "bun:test"
import * as upstream from "agent-hook-schemas/claude"
import * as envelopes from "../schemas.ts"
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

const optionalEnvelopes = [
  [envelopes.sessionHookInputSchema, upstream.PreCompactInputSchema],
  [envelopes.permissionRequestHookInputSchema, upstream.PermissionRequestInputSchema],
  [envelopes.subagentStartHookInputSchema, upstream.SubagentStartInputSchema],
  [envelopes.taskCreatedHookInputSchema, upstream.TaskCreatedInputSchema],
  [envelopes.taskCompletedHookInputSchema, upstream.TaskCompletedInputSchema],
  [envelopes.teammateIdleHookInputSchema, upstream.TeammateIdleInputSchema],
  [envelopes.stopFailureHookInputSchema, upstream.StopFailureInputSchema],
  [envelopes.instructionsLoadedHookInputSchema, upstream.InstructionsLoadedInputSchema],
  [envelopes.configChangeHookInputSchema, upstream.ConfigChangeInputSchema],
  [envelopes.cwdChangedHookInputSchema, upstream.CwdChangedInputSchema],
  [envelopes.fileChangedHookInputSchema, upstream.FileChangedInputSchema],
  [envelopes.worktreeCreateHookInputSchema, upstream.WorktreeCreateInputSchema],
  [envelopes.worktreeRemoveHookInputSchema, upstream.WorktreeRemoveInputSchema],
  [envelopes.postCompactHookInputSchema, upstream.PostCompactInputSchema],
  [envelopes.elicitationHookInputSchema, upstream.ElicitationInputSchema],
  [envelopes.elicitationResultHookInputSchema, upstream.ElicitationResultInputSchema],
] as const

describe("optional envelope null normalization", () => {
  test("every known field treats null exactly like omission without mutating input", () => {
    for (const [schema, source] of optionalEnvelopes) {
      const fields = Object.fromEntries(Object.keys(source.shape).map((key) => [key, null]))
      const extension = { nested: [null, { value: null }] }
      const input = { ...fields, extension, future: null }
      expect(schema.parse(input)).toEqual(schema.parse({ extension, future: null }))
      expect(input).toEqual({ ...fields, extension, future: null })
      expect(schema.parse({ session_id: "session" }).session_id).toBe("session")
      expect(schema.safeParse({ session_id: 42 }).success).toBe(false)
    }
  })

  test("the post-tool failure union branch normalizes null fields", () => {
    const fields = Object.fromEntries(
      Object.keys(upstream.PostToolUseFailureInputSchema.shape).map((key) => [key, null])
    )
    expect(envelopes.postToolUseHookInputSchema.parse(fields)).toEqual({})
  })

  test("nested field validation and unknown nested nulls remain intact", () => {
    const schema = envelopes.permissionRequestHookInputSchema
    expect(schema.parse({ tool_input: { value: null } }).tool_input).toEqual({ value: null })
    expect(schema.safeParse({ tool_input: 42 }).success).toBe(false)
  })
})

describe("preCompact dispatch payload", () => {
  test("accepts a null custom_instructions", () => {
    const payload = { ...CLAUDE_PRECOMPACT_BASE, trigger: "manual", custom_instructions: null }

    expect(sessionHookInputSchema.parse(payload).custom_instructions).toBeUndefined()
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
