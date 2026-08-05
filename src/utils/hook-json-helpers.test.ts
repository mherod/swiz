import { describe, expect, test } from "bun:test"
import { preToolUseDeny } from "../SwizHook.ts"
import {
  extractHookSystemMessagePreview,
  hasNonEmptyHookOutput,
  isJsonLikeRecord,
  messageFromUnknownError,
} from "./hook-json-helpers.ts"

describe("hook-json-helpers", () => {
  test("isJsonLikeRecord", () => {
    expect(isJsonLikeRecord({})).toBe(true)
    expect(isJsonLikeRecord([])).toBe(true)
    expect(isJsonLikeRecord(null)).toBe(false)
    expect(isJsonLikeRecord(undefined)).toBe(false)
    expect(isJsonLikeRecord("x")).toBe(false)
  })

  test("messageFromUnknownError", () => {
    expect(messageFromUnknownError(new Error("e"))).toBe("e")
    expect(messageFromUnknownError("plain")).toBe("plain")
  })

  test("hasNonEmptyHookOutput", () => {
    expect(hasNonEmptyHookOutput({})).toBe(false)
    expect(hasNonEmptyHookOutput({ a: 1 })).toBe(true)
    expect(hasNonEmptyHookOutput(null)).toBe(false)
    expect(hasNonEmptyHookOutput([])).toBe(false)
  })

  test("extracts the first non-blank logical line", () => {
    expect(extractHookSystemMessagePreview("\n  \n  Action required\nMore detail")).toBe(
      "Action required"
    )
  })

  test("keeps the full denial reason while showing its first non-blank line", () => {
    const reason = "\n\nAction required\nMore detail"
    const output = preToolUseDeny(reason) as {
      systemMessage?: string
      hookSpecificOutput?: Record<string, unknown>
    }
    const hookOutput = output.hookSpecificOutput ?? {}

    expect(output.systemMessage).toBe("Action required")
    expect(hookOutput.permissionDecisionReason).toContain(reason)
    expect(hookOutput.permissionDecisionReason).toContain("More detail")
  })
})
