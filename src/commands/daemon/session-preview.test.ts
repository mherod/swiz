import { afterEach, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { TMP_ROOT } from "../../temp-paths.ts"
import { sessionDataCache } from "./session-data.ts"
import {
  MAX_SESSION_CACHE_BYTES,
  MAX_SESSION_PREVIEW_BYTES,
  readSessionPreview,
} from "./session-preview.ts"

const files: string[] = []
afterEach(async () => {
  sessionDataCache.invalidateAll()
  for (const path of files.splice(0)) await Bun.file(path).delete()
})

function assistant(text: string): string {
  return JSON.stringify({
    type: "response_item",
    timestamp: "2026-09-05T10:00:00Z",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  })
}

async function fixture(size: number, tail = assistant("Recent café 🦊")): Promise<string> {
  const dir = join(TMP_ROOT, "swiz-preview-tests")
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${crypto.randomUUID()}.jsonl`)
  files.push(path)
  const writer = Bun.file(path).writer()
  const output = `${JSON.stringify({
    type: "response_item",
    payload: { type: "function_call_output", output: "x".repeat(32 * 1024) },
  })}\n`
  for (let bytes = 0; bytes < size; bytes += output.length) await writer.write(output)
  await writer.write(tail)
  await writer.end()
  return path
}

test("a multi-gigabyte preview reads one bounded suffix and drops the partial first record", async () => {
  const size = 2 * 1024 ** 3
  const slices: Array<[number, number]> = []
  const line = assistant("Recent café 🦊")
  const file = {
    name: "large.jsonl",
    text: () => {
      throw new Error("whole-file read")
    },
    slice: (start: number, end: number) => {
      slices.push([start, end])
      return { text: async () => `partial record\n${line}\n` }
    },
  } as unknown as Bun.BunFile
  expect(await readSessionPreview(file, size, "codex-jsonl")).toBe(`${line}\n`)
  expect(slices).toEqual([[size - MAX_SESSION_PREVIEW_BYTES - 1, size]])
})

test("large non-JSONL formats are not loaded or parsed as truncated documents", async () => {
  const file = {
    slice: () => {
      throw new Error("must not read")
    },
  } as unknown as Bun.BunFile
  for (const format of ["gemini-json", "cursor-sqlite", "antigravity-pb"] as const) {
    expect(await readSessionPreview(file, MAX_SESSION_PREVIEW_BYTES + 1, format)).toBeNull()
  }
})

test("preview reads stop at the observed EOF when the file grows", async () => {
  const path = await fixture(0, `${assistant("First")}\n`)
  const file = Bun.file(path)
  const size = (await file.stat()).size
  await Bun.write(path, `${assistant("First")}\n${assistant("Appended")}\n`)
  expect(await readSessionPreview(file, size, "codex-jsonl")).toBe(`${assistant("First")}\n`)
})

function usage(timestamp: string, output: number): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: 1000 + output,
          input_tokens: 1000,
          output_tokens: output,
          cached_input_tokens: 400,
        },
      },
    },
  })
}

test("large previews preserve recent messages and latest cumulative usage totals", async () => {
  const tail = [
    usage("2026-09-05T10:00:00Z", 100),
    assistant("Recent café 🦊"),
    usage("2026-09-05T10:02:00Z", 300),
  ].join("\n")
  const path = await fixture(MAX_SESSION_PREVIEW_BYTES + 1024 * 1024, tail)
  const result = await sessionDataCache.get({ path, format: "codex-jsonl" })
  expect(result?.messages.map((message) => message.text)).toEqual(["Recent café 🦊"])
  expect(result?.tokenStats).toEqual({
    totalTokens: 1300,
    inputTokens: 1000,
    outputTokens: 300,
    cachedInputTokens: 400,
    outputTokensPerMinute: 100,
  })
  expect(result?.size).toBeGreaterThan(MAX_SESSION_PREVIEW_BYTES)
  expect(sessionDataCache.getMemoryStats().estimatedBytes).toBeLessThan(MAX_SESSION_CACHE_BYTES)
})

test("preview cache evicts by retained bytes across different sessions", async () => {
  const paths = await Promise.all(Array.from({ length: 3 }, () => fixture(6 * 1024 * 1024)))
  const first = await sessionDataCache.get({ path: paths[0]!, format: "codex-jsonl" })
  for (const path of paths.slice(1)) {
    expect(await sessionDataCache.get({ path, format: "codex-jsonl" })).not.toBeNull()
  }
  const stats = sessionDataCache.getMemoryStats()
  expect(stats.entries).toBeLessThan(3)
  expect(stats.estimatedBytes).toBeLessThanOrEqual(MAX_SESSION_CACHE_BYTES)
  expect(await sessionDataCache.get({ path: paths[0]!, format: "codex-jsonl" })).not.toBe(first)
})

test("memory relief prevents admitted and queued reads from refilling the cache", async () => {
  const paths = await Promise.all(Array.from({ length: 4 }, () => fixture(0)))
  const reads = paths.map((path) => sessionDataCache.get({ path, format: "codex-jsonl" }))
  sessionDataCache.invalidateAll()
  const results = await Promise.all(reads)
  expect(results.slice(2)).toEqual([null, null])
  expect(sessionDataCache.getMemoryStats()).toEqual({ entries: 0, estimatedBytes: 0 })
})

test("trimming timestamp-free messages keeps their fallback positions valid", async () => {
  const lines = Array.from({ length: 350 }, (_, index) =>
    JSON.stringify({
      type: "assistant",
      message: { content: `Message ${index}` },
    })
  )
  const path = await fixture(0, lines.join("\n"))
  const result = await sessionDataCache.get({ path, format: "jsonl" })
  expect(result?.messages).toHaveLength(300)
  expect(result?.messages[0]?.text).toBe("Message 50")
  expect(
    result?.messages.every((message) => Number.isFinite(Date.parse(message.timestamp ?? "")))
  ).toBe(true)
})
