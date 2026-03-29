import { describe, expect, test } from "bun:test"
import { stripQuotedShellStrings } from "./shell-patterns.ts"

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
