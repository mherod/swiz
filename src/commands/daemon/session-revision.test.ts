import { describe, expect, test } from "bun:test"
import { computeContentRevision, scopeRevisionToWindow } from "./session-data.ts"
import type { SessionMessage } from "./utils.ts"

const base: SessionMessage[] = [
  { role: "user", text: "First", timestamp: "2026-09-07T10:00:00Z" },
  {
    role: "assistant",
    text: "Hello",
    timestamp: "2026-09-07T10:00:01Z",
    toolCalls: [{ name: "Read", detail: "src/index.ts" }],
  },
]

describe("computeContentRevision", () => {
  test("is stable for identical bounded content", () => {
    expect(computeContentRevision(base)).toBe(computeContentRevision(structuredClone(base)))
  })

  test("tracks earlier edits, deletion, reorder, tools, timestamps and window eviction", () => {
    const variants: SessionMessage[][] = [
      [...base, { ...base[1]!, text: "Next" }],
      [{ ...base[0]!, text: "Other" }, base[1]!],
      base.slice(1),
      [...base].reverse(),
      [base[0]!, { ...base[1]!, toolCalls: [{ name: "Read", detail: "src/other.ts" }] }],
      [{ ...base[0]!, timestamp: "2026-09-07T10:01:00Z" }, base[1]!],
      [base[1]!, { ...base[1]!, text: "Next" }],
    ]
    for (const messages of variants) {
      expect(computeContentRevision(messages)).not.toBe(computeContentRevision(base))
    }
  })

  test("exposes only an opaque digest, including for an empty window", () => {
    expect(computeContentRevision(base)).toMatch(/^[0-9a-z]+$/)
    expect(computeContentRevision([])).toBe(computeContentRevision([]))
    expect(computeContentRevision([])).not.toBe(computeContentRevision(base))
  })
})

describe("scopeRevisionToWindow", () => {
  test("separates limits and captured tool changes", () => {
    const revision = computeContentRevision(base)
    expect(scopeRevisionToWindow(revision, 30)).not.toBe(scopeRevisionToWindow(revision, 150))
    expect(scopeRevisionToWindow(revision, 150, "abc")).not.toBe(
      scopeRevisionToWindow(revision, 150, "def")
    )
    expect(scopeRevisionToWindow(revision, 150, "abc")).toBe(
      scopeRevisionToWindow(revision, 150, "abc")
    )
    expect(scopeRevisionToWindow(undefined, 150)).toBeUndefined()
  })
})
