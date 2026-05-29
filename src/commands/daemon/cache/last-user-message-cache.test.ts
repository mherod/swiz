import { afterAll, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { TMP_ROOT } from "../../../temp-paths.ts"
import {
  findLastUserMessageMsFromTranscript,
  LastUserMessageCache,
} from "./last-user-message-cache.ts"

const created: string[] = []

async function tempTranscript(lines: object[]): Promise<string> {
  const path = join(
    TMP_ROOT,
    `last-user-msg-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`
  )
  created.push(path)
  await Bun.write(path, lines.map((l) => JSON.stringify(l)).join("\n"))
  return path
}

afterAll(async () => {
  await Promise.all(created.map((p) => rm(p, { force: true }).catch(() => {})))
})

describe("LastUserMessageCache", () => {
  test("records and peeks a hook-sourced time", () => {
    const cache = new LastUserMessageCache()
    cache.recordFromHook("s1", 1000)
    expect(cache.peek("s1")).toEqual({ at: 1000, source: "hook" })
  })

  test("peek returns null for unknown session", () => {
    const cache = new LastUserMessageCache()
    expect(cache.peek("missing")).toBeNull()
  })

  test("hook time is monotonic — never moves backwards", () => {
    const cache = new LastUserMessageCache()
    cache.recordFromHook("s1", 2000)
    cache.recordFromHook("s1", 1000)
    expect(cache.peek("s1")?.at).toBe(2000)
    cache.recordFromHook("s1", 3000)
    expect(cache.peek("s1")?.at).toBe(3000)
  })

  test("ignores empty session id and non-finite times", () => {
    const cache = new LastUserMessageCache()
    cache.recordFromHook("", 1000)
    cache.recordFromHook("s1", Number.NaN)
    expect(cache.peek("")).toBeNull()
    expect(cache.peek("s1")).toBeNull()
  })

  test("get falls back to the transcript when nothing is hot", async () => {
    const ts = "2026-05-29T10:00:00.000Z"
    const path = await tempTranscript([
      { type: "user", timestamp: "2026-05-29T09:00:00.000Z", message: { content: "first" } },
      {
        type: "assistant",
        timestamp: "2026-05-29T09:30:00.000Z",
        message: { content: [{ type: "text", text: "hi" }] },
      },
      { type: "user", timestamp: ts, message: { content: "second" } },
    ])
    const cache = new LastUserMessageCache()
    const entry = await cache.get("s1", path)
    expect(entry).toEqual({ at: Date.parse(ts), source: "transcript" })
    // Now hot — peek resolves synchronously.
    expect(cache.peek("s1")).toEqual({ at: Date.parse(ts), source: "transcript" })
  })

  test("get returns null without a transcript path and nothing cached", async () => {
    const cache = new LastUserMessageCache()
    expect(await cache.get("s1")).toBeNull()
  })

  test("hook-sourced entry is preferred over the transcript", async () => {
    const path = await tempTranscript([
      { type: "user", timestamp: "2026-05-29T09:00:00.000Z", message: { content: "old" } },
    ])
    const cache = new LastUserMessageCache()
    cache.recordFromHook("s1", Date.parse("2026-05-29T12:00:00.000Z"))
    const entry = await cache.get("s1", path)
    expect(entry?.source).toBe("hook")
    expect(entry?.at).toBe(Date.parse("2026-05-29T12:00:00.000Z"))
  })

  test("pruneOlderThan drops stale sessions and keeps recent ones", () => {
    const cache = new LastUserMessageCache()
    cache.recordFromHook("old", 1000)
    cache.recordFromHook("fresh", 5000)
    cache.pruneOlderThan(3000)
    expect(cache.peek("old")).toBeNull()
    expect(cache.peek("fresh")?.at).toBe(5000)
  })

  test("invalidate clears a session", () => {
    const cache = new LastUserMessageCache()
    cache.recordFromHook("s1", 1000)
    cache.invalidate("s1")
    expect(cache.peek("s1")).toBeNull()
  })
})

describe("findLastUserMessageMsFromTranscript", () => {
  test("returns the latest genuine user-message time", async () => {
    const ts = "2026-05-29T11:11:11.000Z"
    const path = await tempTranscript([
      { type: "user", timestamp: "2026-05-29T10:00:00.000Z", message: { content: "one" } },
      { type: "user", timestamp: ts, message: { content: "two" } },
    ])
    expect(await findLastUserMessageMsFromTranscript(path)).toBe(Date.parse(ts))
  })

  test("ignores tool_result user entries", async () => {
    const promptTs = "2026-05-29T10:00:00.000Z"
    const path = await tempTranscript([
      { type: "user", timestamp: promptTs, message: { content: "the prompt" } },
      {
        type: "user",
        timestamp: "2026-05-29T10:05:00.000Z",
        message: {
          content: [{ type: "tool_result", tool_use_id: "x", content: "output" }],
        },
      },
    ])
    expect(await findLastUserMessageMsFromTranscript(path)).toBe(Date.parse(promptTs))
  })

  test("accepts user entries with text content arrays", async () => {
    const ts = "2026-05-29T10:00:00.000Z"
    const path = await tempTranscript([
      {
        type: "user",
        timestamp: ts,
        message: { content: [{ type: "text", text: "hello there" }] },
      },
    ])
    expect(await findLastUserMessageMsFromTranscript(path)).toBe(Date.parse(ts))
  })

  test("returns null when there is no user message", async () => {
    const path = await tempTranscript([
      {
        type: "assistant",
        timestamp: "2026-05-29T10:00:00.000Z",
        message: { content: [{ type: "text", text: "hi" }] },
      },
    ])
    expect(await findLastUserMessageMsFromTranscript(path)).toBeNull()
  })

  test("returns null for a missing file", async () => {
    expect(
      await findLastUserMessageMsFromTranscript(join(TMP_ROOT, "does-not-exist-xyz.jsonl"))
    ).toBeNull()
  })
})
