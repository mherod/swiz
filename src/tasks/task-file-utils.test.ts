import { describe, expect, it } from "bun:test"
import { isSessionTaskJsonFile } from "./task-file-utils.ts"

describe("isSessionTaskJsonFile", () => {
  it("accepts normal task basenames", () => {
    expect(isSessionTaskJsonFile("1.json")).toBe(true)
    expect(isSessionTaskJsonFile("a3f2-5.json")).toBe(true)
    expect(isSessionTaskJsonFile("task-foo.json")).toBe(true)
  })

  it("rejects compact snapshot", () => {
    expect(isSessionTaskJsonFile("compact-snapshot.json")).toBe(false)
  })

  it("rejects dot-prefixed and non-json", () => {
    expect(isSessionTaskJsonFile(".session-meta.json")).toBe(false)
    expect(isSessionTaskJsonFile(".foo.json")).toBe(false)
    expect(isSessionTaskJsonFile("notes.txt")).toBe(false)
    expect(isSessionTaskJsonFile("events.jsonl")).toBe(false)
  })

  it("rejects empty and extension-only edge cases", () => {
    expect(isSessionTaskJsonFile("")).toBe(false)
    expect(isSessionTaskJsonFile(".json")).toBe(false)
  })
})
