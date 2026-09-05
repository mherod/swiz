import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { TMP_ROOT } from "../temp-paths.ts"
import { JsonlAppendCursor, streamJsonlEntriesFromFile, streamJsonlLinesFromFile } from "./jsonl.ts"
import { reverseJsonlLines } from "./jsonl-reverse.ts"

const paths: string[] = []
afterEach(async () => {
  for (const path of paths.splice(0)) await Bun.file(path).delete()
})

async function fixture(text: string): Promise<Bun.BunFile> {
  const path = join(TMP_ROOT, `reverse-jsonl-${crypto.randomUUID()}.jsonl`)
  paths.push(path)
  await Bun.write(path, text)
  return Bun.file(path)
}

test("reverse records preserve UTF-8, CRLF, blank lines and an unterminated final record", async () => {
  const lines = ['{"text":"first"}', '{"text":"café 🦊"}', '{"text":"last"}']
  const file = await fixture(`${lines[0]}\r\n\n${lines[1]}\r\n${lines[2]}`)
  const result = await Array.fromAsync(reverseJsonlLines(file, file.size, 3))
  expect(result.map((line) => JSON.parse(line))).toEqual(
    lines.toReversed().map((line) => JSON.parse(line))
  )
})

test("a reverse scan skips an oversized record without losing adjacent records", async () => {
  const file = await fixture(`first\n${"x".repeat(1000)}\nlast\n`)
  expect(await Array.fromAsync(reverseJsonlLines(file, file.size, 7, 20))).toEqual([
    "last",
    "first",
  ])
})

test("a large transcript lookup stops after one fixed tail read", async () => {
  const size = 2 * 1024 ** 3
  const reads: Array<[number, number]> = []
  const file = {
    slice: (start: number, end: number) => {
      reads.push([start, end])
      return { bytes: async () => new TextEncoder().encode('older\n{"message":"recent"}\n') }
    },
  } as unknown as Bun.BunFile
  for await (const line of reverseJsonlLines(file, size)) {
    expect(JSON.parse(line)).toEqual({ message: "recent" })
    break
  }
  expect(reads).toEqual([[size - 256 * 1024, size]])
})

test("a scan with no match reads fixed disjoint chunks to the file start", async () => {
  const data = new TextEncoder().encode("no\nmatching\nrecords\n")
  const reads: Array<[number, number]> = []
  const file = {
    slice: (start: number, end: number) => {
      reads.push([start, end])
      return { bytes: async () => data.slice(start, end) }
    },
  } as unknown as Bun.BunFile
  expect(await Array.fromAsync(reverseJsonlLines(file, data.length, 5))).toEqual([
    "records",
    "matching",
    "no",
  ])
  expect(reads.every(([start, end]) => end - start <= 5)).toBe(true)
  expect(reads.reduce((sum, [start, end]) => sum + end - start, 0)).toBe(data.length)
})

test("a reverse read excludes bytes appended after the observed size", async () => {
  const file = await fixture("first\n")
  const size = file.size
  await Bun.write(file.name!, "first\nnew\n")
  expect(await Array.fromAsync(reverseJsonlLines(file, size, 3))).toEqual(["first"])
})

test("a large append requests a cold rebuild before allocating the delta", async () => {
  const file = await fixture("{}\n")
  const metadata = await file.stat()
  const cursor = new JsonlAppendCursor()
  cursor.reset(metadata)
  const large = { ...metadata, size: metadata.size + 8 * 1024 ** 2 + 1 }
  expect(await cursor.read(file.name!, large)).toEqual({ kind: "cold", lines: [], bytesRead: 0 })
})

test("stream readers accept nonempty slices without a prior size lookup", async () => {
  const file = await fixture('{"a":1}\n{"b":2}\n')
  const size = (await file.stat()).size
  const sliced = () => Bun.file(file.name!).slice(0, size)
  expect(await Array.fromAsync(streamJsonlLinesFromFile(sliced()))).toEqual(['{"a":1}', '{"b":2}'])
  expect(await Array.fromAsync(streamJsonlEntriesFromFile(sliced()))).toEqual([{ a: 1 }, { b: 2 }])
})

test("streaming preserves records split across many chunks", async () => {
  const first = `café 🦊 ${"x".repeat(10000)}`
  const bytes = new TextEncoder().encode(`${first}\n\nlast`)
  const file = {
    size: bytes.length,
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
          controller.close()
        },
      }),
  } as unknown as Bun.BunFile
  expect(await Array.fromAsync(streamJsonlLinesFromFile(file))).toEqual([first, "", "last"])
})

test("streaming cancels an unfinished reader when a consumer stops early", async () => {
  let cancelled = false
  const file = {
    size: 100,
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first\npending"))
        },
        cancel() {
          cancelled = true
        },
      }),
  } as unknown as Bun.BunFile
  for await (const line of streamJsonlLinesFromFile(file)) {
    expect(line).toBe("first")
    break
  }
  expect(cancelled).toBe(true)
})
