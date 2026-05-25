import { describe, expect, test } from "bun:test"
import { tildifyHome } from "./home.ts"

describe("tildifyHome", () => {
  const home = "/Users/matthewherod"

  test("redacts the home prefix when followed by a slash", () => {
    expect(tildifyHome(`${home}/Development/swiz`, home)).toBe("~/Development/swiz")
  })

  test("redacts a bare home path at end of string", () => {
    expect(tildifyHome(`cwd is ${home}`, home)).toBe("cwd is ~")
  })

  test("redacts the home path when followed by a non-word char", () => {
    expect(tildifyHome(`path "${home}" here`, home)).toBe('path "~" here')
  })

  test("redacts every occurrence", () => {
    expect(tildifyHome(`${home}/a and ${home}/b`, home)).toBe("~/a and ~/b")
  })

  test("leaves sibling directories with the same prefix intact", () => {
    expect(tildifyHome(`${home}2/foo`, home)).toBe(`${home}2/foo`)
  })

  test("leaves unrelated paths untouched", () => {
    expect(tildifyHome("/var/log/system.log", home)).toBe("/var/log/system.log")
  })

  test("is a no-op when home is unset, ~, or root", () => {
    expect(tildifyHome(`${home}/x`, "")).toBe(`${home}/x`)
    expect(tildifyHome(`${home}/x`, "~")).toBe(`${home}/x`)
    expect(tildifyHome("/anything", "/")).toBe("/anything")
  })

  test("is a no-op on empty input", () => {
    expect(tildifyHome("", home)).toBe("")
  })

  test("escapes regex-special characters in the home path", () => {
    const special = "/Users/a.b+c"
    expect(tildifyHome(`${special}/x`, special)).toBe("~/x")
    // The dot must be literal, not a wildcard.
    expect(tildifyHome("/Users/aXb+c/x", special)).toBe("/Users/aXb+c/x")
  })
})
