import { describe, expect, test } from "bun:test"
import {
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
})
