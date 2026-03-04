import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { countFileWords } from "./hook-utils.ts"

describe("countFileWords", () => {
  let tempFile: string

  beforeEach(() => {
    tempFile = join(tmpdir(), `test-file-${Date.now()}.txt`)
  })

  afterEach(() => {
    try {
      unlinkSync(tempFile)
    } catch {
      // File may not exist, ignore
    }
  })

  it("returns 0 words for empty file", async () => {
    writeFileSync(tempFile, "")
    const stats = await countFileWords(tempFile)
    expect(stats).toEqual({ words: 0, lines: 0, chars: 0 })
  })

  it("returns 1 word for single word", async () => {
    writeFileSync(tempFile, "hello")
    const stats = await countFileWords(tempFile)
    expect(stats?.words).toBe(1)
  })

  it("counts multiple words correctly", async () => {
    writeFileSync(tempFile, "hello world this is a test")
    const stats = await countFileWords(tempFile)
    expect(stats?.words).toBe(6)
  })

  it("handles LF line endings", async () => {
    writeFileSync(tempFile, "line1\nline2\nline3")
    const stats = await countFileWords(tempFile)
    expect(stats?.lines).toBe(3)
  })

  it("handles CRLF line endings", async () => {
    writeFileSync(tempFile, "line1\r\nline2\r\nline3")
    const stats = await countFileWords(tempFile)
    expect(stats?.lines).toBe(3)
  })

  it("handles file without trailing newline", async () => {
    writeFileSync(tempFile, "line1\nline2\nline3")
    const stats = await countFileWords(tempFile)
    expect(stats?.lines).toBe(3)
  })

  it("handles file with trailing newline", async () => {
    writeFileSync(tempFile, "line1\nline2\nline3\n")
    const stats = await countFileWords(tempFile)
    expect(stats?.lines).toBe(3)
  })

  it("handles BOM (UTF-8 BOM) correctly", async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    const content = Buffer.from("hello world")
    writeFileSync(tempFile, Buffer.concat([bom, content]))
    const stats = await countFileWords(tempFile)
    // The BOM is a character, so it counts as 1 additional character
    expect(stats?.words).toBe(2) // "hello" and "world"
  })

  it("handles Unicode characters (emoji, accents)", async () => {
    writeFileSync(tempFile, "café résumé 🎉 emoji")
    const stats = await countFileWords(tempFile)
    expect(stats?.words).toBe(4) // café, résumé, 🎉, emoji
  })

  it("counts characters correctly", async () => {
    writeFileSync(tempFile, "hello")
    const stats = await countFileWords(tempFile)
    expect(stats?.chars).toBe(5)
  })

  it("returns null for non-existent file", async () => {
    const stats = await countFileWords("/tmp/file-that-does-not-exist-12345.txt")
    expect(stats).toBeNull()
  })

  it("returns null for binary file (contains null bytes)", async () => {
    // Create a binary file with null bytes
    const buffer = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe])
    writeFileSync(tempFile, buffer)
    const stats = await countFileWords(tempFile)
    expect(stats).toBeNull()
  })

  it("handles whitespace-only content", async () => {
    writeFileSync(tempFile, "   \n   \n   ")
    const stats = await countFileWords(tempFile)
    expect(stats?.words).toBe(0)
  })

  it("handles mixed whitespace (tabs, spaces, newlines)", async () => {
    writeFileSync(tempFile, "word1\t\tword2  \n  word3")
    const stats = await countFileWords(tempFile)
    expect(stats?.words).toBe(3)
  })
})
