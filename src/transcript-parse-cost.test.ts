import { describe, expect, test } from "bun:test"
import {
  collectCurrentSessionUsageEvents,
  collectSessionToolUsage,
  extractSessionLines,
  isSessionBoundaryLine,
} from "./transcript-summary.ts"

const assistantRead = JSON.stringify({
  type: "assistant",
  timestamp: "2026-11-25T00:00:01.000Z",
  message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }] },
})
const userTurn = JSON.stringify({
  type: "user",
  timestamp: "2026-11-25T00:00:02.000Z",
  message: { content: "carry on" },
})
const systemEntry = JSON.stringify({ type: "system", subtype: "compact_boundary" })

/** Count JSON parses made while `run` executes. */
function countParses(run: () => void): number {
  const original = Bun.JSONL.parse
  let calls = 0
  Bun.JSONL.parse = (...args: Parameters<typeof original>) => {
    calls++
    return original(...args)
  }
  try {
    run()
  } finally {
    Bun.JSONL.parse = original
  }
  return calls
}

describe("isSessionBoundaryLine", () => {
  test("recognises system and compaction entries, compact or spaced", () => {
    expect(isSessionBoundaryLine(systemEntry)).toBe(true)
    expect(isSessionBoundaryLine('{ "type": "system" }')).toBe(true)
    expect(isSessionBoundaryLine(JSON.stringify({ type: "compacted" }))).toBe(true)
    expect(
      isSessionBoundaryLine(
        JSON.stringify({ type: "event_msg", payload: { type: "context_compacted" } })
      )
    ).toBe(true)
  })

  test("control: lines that only mention the words are not boundaries", () => {
    const quoted = JSON.stringify({ type: "user", message: { content: 'the "system" prompt' } })
    const asValue = JSON.stringify({ type: "assistant", role: "system" })
    const otherEvent = JSON.stringify({ type: "event_msg", payload: { type: "user_message" } })
    expect(isSessionBoundaryLine(quoted)).toBe(false)
    expect(isSessionBoundaryLine(asValue)).toBe(false)
    expect(isSessionBoundaryLine(otherEvent)).toBe(false)
    expect(isSessionBoundaryLine(assistantRead)).toBe(false)
    expect(isSessionBoundaryLine("")).toBe(false)
  })

  test("the boundary scan does not parse ordinary lines", () => {
    const lines = Array.from({ length: 200 }, () => assistantRead)
    const text = [systemEntry, ...lines].join("\n")
    let sessionLines: string[] = []
    const parses = countParses(() => {
      sessionLines = extractSessionLines(text)
    })
    expect(sessionLines).toHaveLength(200)
    // Only the boundary entry carries a marker, so it is the only line parsed.
    expect(parses).toBe(1)
  })
})

describe("per-line transcript collectors", () => {
  const lines = [assistantRead, userTurn, assistantRead]

  test("usage events parse each line once", () => {
    let events: ReturnType<typeof collectCurrentSessionUsageEvents> = []
    const parses = countParses(() => {
      events = collectCurrentSessionUsageEvents(lines)
    })
    expect(parses).toBe(lines.length)
    // Control: the single parse still feeds every extractor.
    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events.every((event) => typeof event.timestamp === "string")).toBe(true)
    expect(events.at(-1)?.turnIndex).toBe(1)
  })

  test("tool usage parses each line once and keeps the timestamps", () => {
    let acc: ReturnType<typeof collectSessionToolUsage> | undefined
    const parses = countParses(() => {
      acc = collectSessionToolUsage(lines)
    })
    expect(parses).toBe(lines.length)
    expect(acc?.firstTimestamp).toBe("2026-11-25T00:00:01.000Z")
    expect(acc?.lastTimestamp).toBe("2026-11-25T00:00:01.000Z")
  })
})
