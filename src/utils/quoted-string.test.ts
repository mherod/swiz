import { describe, expect, test } from "bun:test"
import {
  parseQuotedString,
  requoteString,
  stripQuotes,
  transformQuotedString,
} from "./quoted-string.ts"

describe("parseQuotedString", () => {
  test("parses double-quoted string", () => {
    expect(parseQuotedString('"hello"')).toEqual({ quoteChar: '"', content: "hello" })
  })

  test("parses single-quoted string", () => {
    expect(parseQuotedString("'world'")).toEqual({ quoteChar: "'", content: "world" })
  })

  test("parses unquoted string", () => {
    expect(parseQuotedString("unquoted")).toEqual({ quoteChar: "", content: "unquoted" })
  })

  test("handles trimming before parsing", () => {
    expect(parseQuotedString('  "spaced"  ')).toEqual({ quoteChar: '"', content: "spaced" })
  })

  test("handles empty quoted string", () => {
    expect(parseQuotedString('""')).toEqual({ quoteChar: '"', content: "" })
  })

  test("handles string with quotes inside", () => {
    expect(parseQuotedString('"it\'s"')).toEqual({ quoteChar: '"', content: "it's" })
  })

  test("ignores mismatched quotes (opening only)", () => {
    expect(parseQuotedString('"unmatched')).toEqual({ quoteChar: "", content: '"unmatched' })
  })

  test("ignores mismatched quotes (closing only)", () => {
    expect(parseQuotedString('unmatched"')).toEqual({ quoteChar: "", content: 'unmatched"' })
  })
})

describe("stripQuotes", () => {
  test("removes double quotes", () => {
    expect(stripQuotes('"hello"')).toBe("hello")
  })

  test("removes single quotes", () => {
    expect(stripQuotes("'world'")).toBe("world")
  })

  test("leaves unquoted string as-is", () => {
    expect(stripQuotes("unquoted")).toBe("unquoted")
  })

  test("handles whitespace and quotes", () => {
    expect(stripQuotes('  "  spaced  "  ')).toBe("  spaced  ")
  })

  test("handles empty quoted string", () => {
    expect(stripQuotes('""')).toBe("")
  })
})

describe("requoteString", () => {
  test("adds double quotes when quoteChar is double-quote", () => {
    expect(requoteString("hello", '"')).toBe('"hello"')
  })

  test("adds single quotes when quoteChar is single-quote", () => {
    expect(requoteString("world", "'")).toBe("'world'")
  })

  test("leaves string unquoted when quoteChar is empty", () => {
    expect(requoteString("unquoted", "")).toBe("unquoted")
  })

  test("handles empty content", () => {
    expect(requoteString("", '"')).toBe('""')
  })
})

describe("transformQuotedString", () => {
  test("transforms content and preserves double quotes", () => {
    const result = transformQuotedString('"hello"', (s) => s.toUpperCase())
    expect(result).toEqual({ result: '"HELLO"', unmapped: undefined })
  })

  test("transforms content and preserves single quotes", () => {
    const result = transformQuotedString("'world'", (s) => s.toUpperCase())
    expect(result).toEqual({ result: "'WORLD'", unmapped: undefined })
  })

  test("transforms unquoted content", () => {
    const result = transformQuotedString("hello", (s) => s.toUpperCase())
    expect(result).toEqual({ result: "HELLO", unmapped: undefined })
  })

  test("tracks unmapped when transform has no effect", () => {
    const result = transformQuotedString('"hello"', (s) => s)
    expect(result).toEqual({ result: '"hello"', unmapped: "hello" })
  })

  test("handles complex transformations", () => {
    const result = transformQuotedString('"tool-name"', (s) => s.replace(/-/g, "_"))
    expect(result).toEqual({ result: '"tool_name"', unmapped: undefined })
  })

  test("tracks unmapped for unquoted strings when no change", () => {
    const result = transformQuotedString("unquoted", (s) => s)
    expect(result).toEqual({ result: "unquoted", unmapped: "unquoted" })
  })
})
