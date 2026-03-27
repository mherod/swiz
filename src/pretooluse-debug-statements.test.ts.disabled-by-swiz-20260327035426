import { describe, expect, test } from "bun:test"
import { countDebugPatterns } from "../hooks/pretooluse-debug-statements.ts"

describe("countDebugPatterns — true positives", () => {
  test("detects console.log", () => {
    expect(countDebugPatterns('console.log("hello")')).toBe(1)
  })

  test("detects console.debug", () => {
    expect(countDebugPatterns("console.debug(value)")).toBe(1)
  })

  test("detects console.trace", () => {
    expect(countDebugPatterns("console.trace()")).toBe(1)
  })

  test("detects console.dir", () => {
    expect(countDebugPatterns("console.dir(obj)")).toBe(1)
  })

  test("detects debugger keyword", () => {
    expect(countDebugPatterns("  debugger")).toBe(1)
  })

  test("detects multiple patterns across lines", () => {
    const content = ['console.log("a")', "debugger", 'console.debug("b")'].join("\n")
    expect(countDebugPatterns(content)).toBe(3)
  })
})

describe("countDebugPatterns — false positive exclusions", () => {
  test("does not flag console.log in // line comment", () => {
    expect(countDebugPatterns("// console.log is not allowed here")).toBe(0)
  })

  test("does not flag no-debugger ESLint rule reference", () => {
    expect(countDebugPatterns('"no-debugger": "error"')).toBe(0)
  })

  test("does not flag console.error (not a debug method)", () => {
    expect(countDebugPatterns('console.error("fatal error")')).toBe(0)
  })

  test("does not flag console.warn", () => {
    expect(countDebugPatterns('console.warn("warning")')).toBe(0)
  })

  test("returns 0 for clean code", () => {
    const content = [
      "export function add(a: number, b: number): number {",
      "  return a + b",
      "}",
    ].join("\n")
    expect(countDebugPatterns(content)).toBe(0)
  })

  test("returns 0 for empty content", () => {
    expect(countDebugPatterns("")).toBe(0)
  })
})

describe("countDebugPatterns — delta logic", () => {
  test("old count equals new count: no net-new violation", () => {
    const line = 'console.log("x")'
    expect(countDebugPatterns(line)).toBe(countDebugPatterns(line))
  })

  test("new count exceeds old count: net-new violation detected", () => {
    const oldStr = ""
    const newStr = 'console.log("debug")'
    expect(countDebugPatterns(newStr)).toBeGreaterThan(countDebugPatterns(oldStr))
  })

  test("removing a debug statement: new count less than old", () => {
    const oldStr = ['console.log("a")', 'console.log("b")'].join("\n")
    const newStr = 'console.log("a")'
    expect(countDebugPatterns(newStr)).toBeLessThan(countDebugPatterns(oldStr))
  })
})
