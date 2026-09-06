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

  it("requires a cold rebuild for a same-size rewrite with stable identity", async () => {
    // An in-place rewrite of equal length keeps dev/ino and size, moving only mtime. The
    // identity check used to accept that as continuity and the size check then served a
    // hot hit, so the replaced contents were never read (#819).
    const cursor = new JsonlAppendCursor()
    cursor.reset({ size: 10, mtimeMs: 1, dev: 7, ino: 42 })
    await expect(
      cursor.read("/missing", { size: 10, mtimeMs: 2, dev: 7, ino: 42 })
    ).resolves.toMatchObject({ kind: "cold" })
  })

  it("still reports a hot hit when identity, size, and mtime are all unchanged", async () => {
    // Control for the two rebuild cases above: without it they would pass just as well
    // against a cursor that had been made to rebuild unconditionally.
    const cursor = new JsonlAppendCursor()
    cursor.reset({ size: 10, mtimeMs: 1, dev: 7, ino: 42 })
    await expect(
      cursor.read("/missing", { size: 10, mtimeMs: 1, dev: 7, ino: 42 })
    ).resolves.toMatchObject({ kind: "hit" })
  })

  it("requires a cold rebuild when device/inode identity is lost between reads", async () => {
    // Identity that disappears is as unprovable as identity that changed; the old
    // `previousIdentity && nextIdentity` guard skipped this case entirely.
    const cursor = new JsonlAppendCursor()
    cursor.reset({ size: 10, mtimeMs: 1, dev: 7, ino: 42 })
    await expect(cursor.read("/missing", { size: 20, mtimeMs: 2 })).resolves.toMatchObject({
      kind: "cold",
    })
  })

  it("requires a cold rebuild when device/inode identity appears between reads", async () => {
    const cursor = new JsonlAppendCursor()
    cursor.reset({ size: 10, mtimeMs: 1 })
    await expect(
      cursor.read("/missing", { size: 20, mtimeMs: 2, dev: 7, ino: 42 })
    ).resolves.toMatchObject({ kind: "cold" })
  })

  it("seed carries an unterminated tail so its completion is reduced exactly once", async () => {
    await resetTestDir()
    const path = join(TEST_DIR, "seed.jsonl")
    // A cold reader observed the whole file, but the final record is still being written.
    await Bun.write(path, '{"id":1}\n{"id":2')
    const stat = await Bun.file(path).stat()
    const metadata = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      dev: (stat as { dev?: number }).dev,
      ino: (stat as { ino?: number }).ino,
    }

    const cursor = new JsonlAppendCursor()
    cursor.seed(metadata, '{"id":2')
    expect(cursor.tailText).toBe('{"id":2')

    await appendFile(path, "}\n")
    const done = await Bun.file(path).stat()
    const update = await cursor.read(path, {
      size: done.size,
      mtimeMs: done.mtimeMs,
      dev: (done as { dev?: number }).dev,
      ino: (done as { ino?: number }).ino,
    })
    // The whole record, not the bare `}` suffix that `reset` would have yielded.
    expect(update.lines).toEqual(['{"id":2}'])
  })

  it("reset drops the tail, which is why the cold path must seed instead", async () => {
    // Control pinning the difference the seed API exists for: same fixture, same append,
    // and `reset` yields the orphaned suffix that corrupted durable state (#819).
    await resetTestDir()
    const path = join(TEST_DIR, "reset-drops.jsonl")
    await Bun.write(path, '{"id":1}\n{"id":2')
    const stat = await Bun.file(path).stat()
    const cursor = new JsonlAppendCursor()
    cursor.reset({
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      dev: (stat as { dev?: number }).dev,
      ino: (stat as { ino?: number }).ino,
    })

    await appendFile(path, "}\n")
    const done = await Bun.file(path).stat()
    const update = await cursor.read(path, {
      size: done.size,
      mtimeMs: done.mtimeMs,
      dev: (done as { dev?: number }).dev,
      ino: (done as { ino?: number }).ino,
    })
    expect(update.lines).toEqual(["}"])
  })

  it("never reads past the observed size, so a concurrent append lands exactly once", async () => {
    // Bytes written after the stat must not be consumed against the older size and then
    // read again on the next pass. `readTailSlice` grew its `fileSize` upper bound in
    // e1d27627; this pins the same guarantee for the append cursor's own bounded slice.
    await resetTestDir()
    const path = join(TEST_DIR, "concurrent.jsonl")
    await Bun.write(path, '{"id":1}\n')
    const cursor = new JsonlAppendCursor()
    const first = await Bun.file(path).stat()
    cursor.reset({
      size: first.size,
      mtimeMs: first.mtimeMs,
      dev: (first as { dev?: number }).dev,
      ino: (first as { ino?: number }).ino,
    })

    await appendFile(path, '{"id":2}\n')
    const observed = await Bun.file(path).stat()
    // A writer races in after the stat is taken.
    await appendFile(path, '{"id":3}\n')

    const staleRead = await cursor.read(path, {
      size: observed.size,
      mtimeMs: observed.mtimeMs,
      dev: (observed as { dev?: number }).dev,
      ino: (observed as { ino?: number }).ino,
    })
    expect(staleRead.lines).toEqual(['{"id":2}'])

    const latest = await Bun.file(path).stat()
    const nextRead = await cursor.read(path, {
      size: latest.size,
      mtimeMs: latest.mtimeMs,
      dev: (latest as { dev?: number }).dev,
      ino: (latest as { ino?: number }).ino,
    })
    // Neither skipped above nor repeated here.
    expect(nextRead.lines).toEqual(['{"id":3}'])
  })

  it("seed survives a tail split mid UTF-8 sequence", async () => {
    await resetTestDir()
    const path = join(TEST_DIR, "seed-utf8.jsonl")
    const record = '{"value":"café"}'
    await Bun.write(path, record.slice(0, -3))
    const stat = await Bun.file(path).stat()
    const cursor = new JsonlAppendCursor()
    cursor.seed(
      {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        dev: (stat as { dev?: number }).dev,
        ino: (stat as { ino?: number }).ino,
      },
      record.slice(0, -3)
    )

    await appendFile(path, `${record.slice(-3)}\n`)
    const done = await Bun.file(path).stat()
    const update = await cursor.read(path, {
      size: done.size,
      mtimeMs: done.mtimeMs,
      dev: (done as { dev?: number }).dev,
      ino: (done as { ino?: number }).ino,
    })
    expect(update.lines).toEqual([record])
  })
})
