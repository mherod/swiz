import { describe, expect, test } from "bun:test"
import { splitShellSegments, stripQuotedShellStrings } from "./shell-patterns.ts"

describe("stripQuotedShellStrings", () => {
  test("preserves empty quote pairs when requested", () => {
    const command = `cmd --message "hello world" --note 'done'`
    expect(stripQuotedShellStrings(command, { preserveQuotePairs: true })).toBe(
      `cmd --message "" --note ''`
    )
  })

  test("respects escaped double quotes inside double-quoted strings", () => {
    const command = String.raw`cmd "a \"quoted\" value" tail`
    expect(stripQuotedShellStrings(command, { preserveQuotePairs: true })).toBe(`cmd "" tail`)
  })

  test("can also strip backtick strings for diagnostic command matching", () => {
    const command = "cmd \"value\" `inner` 'tail'"
    expect(stripQuotedShellStrings(command, { stripBackticks: true })).toBe("cmd   ")
  })
})

describe("splitShellSegments", () => {
  test("splits executable segments on unquoted shell operators", () => {
    expect(splitShellSegments("rg foo hooks | bun test && git status; swiz settings")).toEqual([
      "rg foo hooks",
      "bun test",
      "git status",
      "swiz settings",
    ])
  })

  test("preserves quoted operators as argument text", () => {
    expect(splitShellSegments('rg "|bun test" file.ts; grep "& done" hooks/*.ts')).toEqual([
      'rg "|bun test" file.ts',
      'grep "& done" hooks/*.ts',
    ])
  })

  test("does not split file descriptor redirects on ampersand", () => {
    expect(splitShellSegments("bun test src/foo.test.ts 2>&1 > out.log")).toEqual([
      "bun test src/foo.test.ts 2>&1 > out.log",
    ])
  })
})
