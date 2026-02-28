import { describe, expect, it } from "vitest"
import { stripNonCode } from "./pretooluse-no-as-any.ts"

// ─── helpers ────────────────────────────────────────────────────────────────

const CAST_RE = /\bas\s+any\b/g

function castCount(src: string): number {
  return (stripNonCode(src).match(CAST_RE) ?? []).length
}

// ─── true-positive: casts in real code must be detected ─────────────────────

describe("stripNonCode — true positives (real casts must be detected)", () => {
  it("detects a bare cast expression in plain code", () => {
    expect(castCount("const x = foo() as any")).toBe(1)
  })

  it("detects a cast that is the entire expression", () => {
    expect(castCount("return value as any")).toBe(1)
  })

  it("counts multiple casts in the same snippet", () => {
    expect(castCount("const a = x as any\nconst b = y as any")).toBe(2)
  })

  it("detects a cast inside a template literal interpolation", () => {
    // The expression inside ${} is real code — a cast there is a real violation
    expect(castCount("`prefix ${x as any} suffix`")).toBe(1)
  })

  it("detects a cast nested inside an interpolation with balanced braces", () => {
    // The } of the object literal must not terminate the interpolation early
    expect(castCount("`${foo({ key: val as any })}`")).toBe(1)
  })

  it("detects multiple casts across different interpolations", () => {
    expect(castCount("`${a as any} literal ${b as any}`")).toBe(2)
  })
})

// ─── false-positive prevention: non-code regions must be blanked ─────────────

describe("stripNonCode — false-positive prevention (non-code must be blanked)", () => {
  describe("line comments", () => {
    it("blanks a cast phrase that appears after //", () => {
      expect(castCount("// comment mentioning the cast pattern\nconst x = 1")).toBe(0)
    })

    it("does not blank code on the line after a line comment", () => {
      // ensure the comment boundary is respected
      expect(castCount("// ignore\nconst z = 1")).toBe(0)
    })
  })

  describe("block comments", () => {
    it("blanks content inside /* */", () => {
      expect(castCount("/* block comment with cast pattern */")).toBe(0)
    })

    it("preserves code that follows a closed block comment", () => {
      expect(castCount("/* comment */ const x = 1")).toBe(0)
    })

    it("handles multiline block comments", () => {
      expect(castCount("/*\n * multiline block comment\n */\nconst x = 1")).toBe(0)
    })
  })

  describe("double-quoted strings", () => {
    it("blanks content inside double-quoted strings", () => {
      expect(castCount('"phrase in a string"')).toBe(0)
    })

    it("handles an escaped double-quote inside a double-quoted string", () => {
      // escaped quote must not terminate the string early
      expect(castCount('"he said \\"hello\\" here"')).toBe(0)
    })

    it("handles backslash-escaped content at end of string", () => {
      expect(castCount('"trailing escape\\\\"')).toBe(0)
    })
  })

  describe("single-quoted strings", () => {
    it("blanks content inside single-quoted strings", () => {
      expect(castCount("'phrase in a string'")).toBe(0)
    })

    it("handles an escaped single-quote inside a single-quoted string", () => {
      expect(castCount("'don\\'t forget this'")).toBe(0)
    })
  })

  describe("template literal body (outside interpolations)", () => {
    it("blanks template literal body content", () => {
      expect(castCount("`template body text`")).toBe(0)
    })

    it("handles an escaped backtick inside a template literal", () => {
      expect(castCount("`before \\` after`")).toBe(0)
    })
  })

  describe("comment-like tokens inside strings (must NOT trigger comment mode)", () => {
    it("does not treat // inside a double-quoted string as a line comment", () => {
      // everything between the quotes should still be blanked as string content
      expect(castCount('"// phrase in string"')).toBe(0)
    })

    it("does not treat /* inside a double-quoted string as a block comment", () => {
      expect(castCount('"/* phrase in string */"')).toBe(0)
    })

    it("does not treat // inside a single-quoted string as a line comment", () => {
      expect(castCount("'// phrase in string'")).toBe(0)
    })
  })

  describe("string-like tokens inside comments (must NOT trigger string mode)", () => {
    it("does not treat a double-quote inside a line comment as a string opener", () => {
      expect(castCount('// "phrase in comment"')).toBe(0)
    })

    it("does not treat a single-quote inside a line comment as a string opener", () => {
      expect(castCount("// 'phrase in comment'")).toBe(0)
    })
  })
})

// ─── template literal boundary behaviour ────────────────────────────────────

describe("stripNonCode — template literal boundary precision", () => {
  it("blanks casts in template body while preserving casts in interpolation", () => {
    // Only the interpolation cast should survive; the body cast should be blanked
    const result = stripNonCode("`body ${x as any} body`")
    const matches = result.match(CAST_RE) ?? []
    expect(matches).toHaveLength(1)
  })

  it("preserves code between interpolation and end of template", () => {
    // After the closing } the remaining template body must still be blanked
    const result = stripNonCode("`${code} trailing body`")
    // "code" token should be present in output; "trailing body" should be spaces
    expect(result).toMatch(/code/)
    expect(result).not.toMatch(/trailing/)
  })

  it("handles adjacent interpolations", () => {
    expect(castCount("`${a as any}${b as any}`")).toBe(2)
  })
})

// ─── output structure invariants ────────────────────────────────────────────

describe("stripNonCode — output structure", () => {
  it("returns a string of the same length as the input", () => {
    const src = "const x = 1 // comment\nconst y = 2"
    expect(stripNonCode(src)).toHaveLength(src.length)
  })

  it("preserves newline positions", () => {
    const src = "line1\n// comment\nline3"
    const result = stripNonCode(src)
    expect(result.split("\n")).toHaveLength(3)
  })

  it("returns an empty string for empty input", () => {
    expect(stripNonCode("")).toBe("")
  })
})
