import { describe, expect, test } from "bun:test"
import { linesAfterLatestUserMessage } from "./transcript-utils.ts"

function entry(type: string, text: string): string {
  return JSON.stringify({ type, message: { content: [{ type: "text", text }] } })
}

describe("transcript-window", () => {
  test("keeps all lines when no user message exists", () => {
    const lines = [entry("assistant", "one"), entry("assistant", "two")]
    expect(linesAfterLatestUserMessage(lines)).toEqual(lines)
  })

  test("returns only lines after the latest user message", () => {
    const fresh = entry("assistant", "fresh")
    expect(
      linesAfterLatestUserMessage([
        entry("user", "old request"),
        entry("assistant", "stale"),
        entry("user", "new request"),
        fresh,
      ])
    ).toEqual([fresh])
  })

  test("recognizes role-based user entries", () => {
    const fresh = entry("assistant", "fresh")
    expect(
      linesAfterLatestUserMessage([JSON.stringify({ role: "user", content: "go" }), fresh])
    ).toEqual([fresh])
  })
})
