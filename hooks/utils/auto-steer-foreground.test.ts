import { describe, expect, it } from "bun:test"
import { isAutoSteerDeferredForForegroundAppName } from "./hook-utils.ts"

describe("isAutoSteerDeferredForForegroundAppName", () => {
  it("defers for WhatsApp and Telegram process names", () => {
    expect(isAutoSteerDeferredForForegroundAppName("WhatsApp")).toBe(true)
    expect(isAutoSteerDeferredForForegroundAppName("WhatsApp Business")).toBe(true)
    expect(isAutoSteerDeferredForForegroundAppName("Telegram")).toBe(true)
    expect(isAutoSteerDeferredForForegroundAppName("telegram")).toBe(true)
  })

  it("does not defer for terminal and unrelated apps", () => {
    expect(isAutoSteerDeferredForForegroundAppName("Terminal")).toBe(false)
    expect(isAutoSteerDeferredForForegroundAppName("iTerm")).toBe(false)
    expect(isAutoSteerDeferredForForegroundAppName("Safari")).toBe(false)
  })
})
