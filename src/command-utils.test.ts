import { describe, expect, test } from "bun:test"
import { bunTestArgSegments, isSingleFileBunTestArgs } from "./command-utils.ts"

describe("bunTestArgSegments", () => {
  test("extracts real bun test invocations from shell segments", () => {
    expect(bunTestArgSegments("rg foo hooks | bun test && bun test src/foo.test.ts")).toEqual([
      "",
      " src/foo.test.ts",
    ])
  })

  test("ignores quoted bun test text", () => {
    expect(bunTestArgSegments('rg -v "bun test" file.ts; grep "|bun test" hooks/*.ts')).toEqual([])
  })

  test("normalizes backslash-newline continuations", () => {
    expect(bunTestArgSegments("bun \\\n  test --concurrent")).toEqual([" --concurrent"])
  })
})

describe("isSingleFileBunTestArgs", () => {
  test("accepts exactly one test file", () => {
    expect(isSingleFileBunTestArgs(" src/foo.test.ts --reporter=dots")).toBe(true)
  })

  test("rejects multiple test files and directory runs", () => {
    expect(isSingleFileBunTestArgs(" src/foo.test.ts src/bar.test.ts")).toBe(false)
    expect(isSingleFileBunTestArgs(" src/")).toBe(false)
  })
})
