import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { TMP_ROOT } from "../temp-paths.ts"
import { parseJsonlUntyped, streamJsonlEntries, tryParseJsonLine } from "./jsonl.ts"

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
})
