import { describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import { unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { countFileWords } from "./utils/hook-utils.ts"

/** Create a unique temp file path for each test (concurrent-safe). */
function uniqueTempFile(): string {
  return join(tmpdir(), `test-file-${randomBytes(8).toString("hex")}.txt`)
}

describe("countFileWords", () => {
  it("returns 0 words for empty file", async () => {
    const f = uniqueTempFile()
    writeFileSync(f, "")
    const stats = await countFileWords(f)
    expect(stats).toEqual({ words: 0, lines: 0, chars: 0 })
    try {
      unlinkSync(f)
    } catch {}
  })

  it("returns 1 word for single word", async () => {
    const f = uniqueTempFile()
    writeFileSync(f, "hello")
    const stats = await countFileWords(f)
    expect(stats?.words).toBe(1)
    try {
      unlinkSync(f)
    } catch {}
  })

  it("counts multiple words correctly", async () => {
    const f = uniqueTempFile()
    writeFileSync(f, "hello world this is a test")
    const stats = await countFileWords(f)
    expect(stats?.words).toBe(6)
    try {
      unlinkSync(f)
    } catch {}
  })

  it("handles LF line endings", async () => {
    const f = uniqueTempFile()
    writeFileSync(f, "line1\nline2\nline3")
    const stats = await countFileWords(f)
    expect(stats?.lines).toBe(3)
    try {
      unlinkSync(f)
    } catch {}
  })

  it("handles CRLF line endings", async () => {
    const f = uniqueTempFile()
    writeFileSync(f, "line1\r\nline2\r\nline3")
    const stats = await countFileWords(f)
    expect(stats?.lines).toBe(3)
    try {
      unlinkSync(f)
    } catch {}
  })

  it("handles file without trailing newline", async () => {
    const f = uniqueTempFile()
    writeFileSync(f, "line1\nline2\nline3")
    const stats = await countFileWords(f)
    expect(stats?.lines).toBe(3)
    try {
      unlinkSync(f)
    } catch {}
  })

  it("handles file with trailing newline", async () => {
    const f = uniqueTempFile()
    writeFileSync(f, "line1\nline2\nline3\n")
    const stats = await countFileWords(f)
    expect(stats?.lines).toBe(3)
    try {
      unlinkSync(f)
    } catch {}
  })

  it("handles BOM (UTF-8 BOM) correctly", async () => {
    const f = uniqueTempFile()
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    const content = Buffer.from("hello world")
    writeFileSync(f, Buffer.concat([bom, content]))
    const stats = await countFileWords(f)
    // The BOM is a character, so it counts as 1 additional character
    expect(stats?.words).toBe(2) // "hello" and "world"
    try {
      unlinkSync(f)
    } catch {}
  })

  it("handles Unicode characters (emoji, accents)", async () => {
    const f = uniqueTempFile()
    writeFileSync(f, "café résumé 🎉 emoji")
    const stats = await countFileWords(f)
    expect(stats?.words).toBe(4) // café, résumé, 🎉, emoji
    try {
      unlinkSync(f)
    } catch {}
  })

  it("counts characters correctly", async () => {
    const f = uniqueTempFile()
    writeFileSync(f, "hello")
    const stats = await countFileWords(f)
    expect(stats?.chars).toBe(5)
    try {
      unlinkSync(f)
    } catch {}
  })

  it("returns null for non-existent file", async () => {
    const stats = await countFileWords("/tmp/file-that-does-not-exist-12345.txt")
    expect(stats).toBeNull()
  })

  it("returns null for binary file (contains null bytes)", async () => {
    const f = uniqueTempFile()
    const buffer = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe])
    writeFileSync(f, buffer)
    const stats = await countFileWords(f)
    expect(stats).toBeNull()
    try {
      unlinkSync(f)
    } catch {}
  })

  it("handles whitespace-only content", async () => {
    const f = uniqueTempFile()
    writeFileSync(f, "   \n   \n   ")
    const stats = await countFileWords(f)
    expect(stats?.words).toBe(0)
    try {
      unlinkSync(f)
    } catch {}
  })

  it("handles mixed whitespace (tabs, spaces, newlines)", async () => {
    const f = uniqueTempFile()
    writeFileSync(f, "word1\t\tword2  \n  word3")
    const stats = await countFileWords(f)
    expect(stats?.words).toBe(3)
    try {
      unlinkSync(f)
    } catch {}
  })
})
