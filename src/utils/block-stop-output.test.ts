import { describe, expect, it } from "bun:test"
import { blockStopObj } from "./hook-utils.ts"

describe("blockStopObj", () => {
  it("keeps a long first line in systemMessage (not 70-char junk truncation)", () => {
    const long = `${"A".repeat(200)} end`
    const out = blockStopObj(`${long}\nline two`)
    expect(typeof out.systemMessage).toBe("string")
    expect(out.systemMessage).toContain("AAAA")
    expect(out.systemMessage).toContain(" end")
    expect(out.systemMessage?.includes("line two")).toBe(false)
    expect((out.systemMessage ?? "").length).toBeGreaterThan(70)
  })
})
