import { afterEach, describe, expect, it } from "bun:test"
import { appendFile, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { TMP_ROOT } from "../temp-paths.ts"
import {
  JsonlAppendCursor,
  parseJsonlUntyped,
  readJsonlFileTailUntyped,
  readJsonlTailText,
  splitJsonlLines,
  streamJsonlEntries,
  streamJsonlEntriesFromFile,
  tryParseJsonLine,
} from "./jsonl.ts"

const TEST_DIR = join(TMP_ROOT, "swiz-jsonl-tests")

async function resetTestDir(): Promise<void> {
  await rm(TEST_DIR, { recursive: true, force: true })
  await mkdir(TEST_DIR, { recursive: true })
}

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

describe("jsonl utilities", () => {
  it("tryParseJsonLine parses a single valid JSONL record", () => {
    expect(tryParseJsonLine('{"name":"Alice"}')).toEqual({ name: "Alice" })
    expect(tryParseJsonLine("")).toBeUndefined()
    expect(tryParseJsonLine("{invalid}")).toBeUndefined()
  })

  it("parseJsonlUntyped skips malformed lines", () => {
    const input = ['{"id":1}', "{invalid}", '{"id":2}'].join("\n")
    expect(parseJsonlUntyped(input)).toEqual([{ id: 1 }, { id: 2 }])
  })

  it("streamJsonlEntries yields valid records while skipping malformed lines", async () => {
    await resetTestDir()
    const path = join(TEST_DIR, "stream.jsonl")
    await Bun.write(
      path,
      [
        '{"id":1,"name":"Alice"}',
        "{invalid}",
        '{"id":2,"name":"Bob"}',
        '{"id":3,"name":"Charlie"}',
      ].join("\n")
    )

    const entries: unknown[] = []
    for await (const entry of streamJsonlEntries(path)) {
      entries.push(entry)
    }

    expect(entries).toEqual([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
      { id: 3, name: "Charlie" },
    ])
  })

  it("cancels the file stream when a consumer stops before EOF", async () => {
    let cancelCalls = 0
    const encoder = new TextEncoder()
    const file = {
      exists: async () => true,
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('{"id":1}\n{"id":2}\n'))
          },
          cancel() {
            cancelCalls++
          },
        }),
    } as Bun.BunFile

    for await (const _entry of streamJsonlEntriesFromFile(file)) break

    expect(cancelCalls).toBe(1)
  })

  it("readJsonlTailText returns complete records from the suffix", async () => {
    await resetTestDir()
    const path = join(TEST_DIR, "tail.jsonl")
    const first = JSON.stringify({ id: 1, payload: "x".repeat(1000) })
    const second = JSON.stringify({ id: 2 })
    const third = JSON.stringify({ id: 3 })
    await Bun.write(path, [first, second, third].join("\n"))

    const result = await readJsonlTailText(path, {
      initialBytes: 20,
      isEnough: (text) => splitJsonlLines(text).length >= 2,
    })

    expect(result?.reachedStart).toBe(false)
    expect(splitJsonlLines(result?.text ?? "")).toEqual([second, third])
  })

  it("readJsonlFileTailUntyped parses only the recent tail entries", async () => {
    await resetTestDir()
    const path = join(TEST_DIR, "tail-untyped.jsonl")
    await Bun.write(
      path,
      Array.from({ length: 5 }, (_, index) => JSON.stringify({ id: index + 1 })).join("\n")
    )

    await expect(readJsonlFileTailUntyped(path, 2)).resolves.toEqual([{ id: 4 }, { id: 5 }])
  })

  it("emits an append record only once its newline and split UTF-8 bytes arrive", async () => {
    await resetTestDir()
    const path = join(TEST_DIR, "append.jsonl")
    await Bun.write(path, '{"id":1}\n')
    const cursor = new JsonlAppendCursor()
    const initial = await Bun.file(path).stat()
    const metadata = {
      size: initial.size,
      mtimeMs: initial.mtimeMs,
      dev: (initial as { dev?: number }).dev,
      ino: (initial as { ino?: number }).ino,
    }
    expect((await cursor.read(path, metadata)).kind).toBe("cold")
    cursor.reset(metadata)

    const encoded = new TextEncoder().encode('{"value":"café"}\n')
    const splitAt = encoded.indexOf(0xc3) + 1
    await appendFile(path, encoded.slice(0, splitAt))
    const partialStat = await Bun.file(path).stat()
    const partial = await cursor.read(path, {
      size: partialStat.size,
      mtimeMs: partialStat.mtimeMs,
      dev: (partialStat as { dev?: number }).dev,
      ino: (partialStat as { ino?: number }).ino,
    })
    expect(partial).toMatchObject({ kind: "append", lines: [] })

    await appendFile(path, encoded.slice(splitAt))
    const completeStat = await Bun.file(path).stat()
    const complete = await cursor.read(path, {
      size: completeStat.size,
      mtimeMs: completeStat.mtimeMs,
      dev: (completeStat as { dev?: number }).dev,
      ino: (completeStat as { ino?: number }).ino,
    })
    expect(complete.lines).toEqual(['{"value":"café"}'])
  })

  it("requires a cold rebuild for a same-size rewrite without stable identity", async () => {
    const cursor = new JsonlAppendCursor()
    cursor.reset({ size: 10, mtimeMs: 1 })
    await expect(cursor.read("/missing", { size: 10, mtimeMs: 2 })).resolves.toMatchObject({
      kind: "cold",
    })
  })
})
