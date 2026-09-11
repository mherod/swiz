import { describe, expect, test } from "bun:test"
import { substituteArgs } from "./skill-content.ts"

describe("substituteArgs", () => {
  test("replaces $ARGUMENTS and positional args safely", () => {
    const content = "$ARGUMENTS / $0 / $1"
    const result = substituteArgs(content, ["first", "second"])
    expect(result).toBe("first second / first / second")
  })

  test("does not interpret replacement tokens inside argument values", () => {
    const content = "$0\n$1\n$ARGUMENTS"
    const result = substituteArgs(content, ["hello $' world", "hello $& world"])
    expect(result).toBe("hello $' world\nhello $& world\nhello $' world hello $& world")
  })

  test("preserves literal $ in replacement values without escaping", () => {
    const content = "prefix-$0-suffix"
    const result = substituteArgs(content, ["cost$ and $& and $'"])
    expect(result).toBe("prefix-cost$ and $& and $'-suffix")
  })

  test("skips substitution when args are empty", () => {
    expect(substituteArgs("no args here", [])).toBe("no args here")
  })
})
