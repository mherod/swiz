import { describe, expect, test } from "bun:test"
import { GIT_GLOBAL_OPTS as fromHooks } from "../utils/shell-patterns.ts"
import { GIT_GLOBAL_OPTS as fromWeb } from "./lib/git-global-opts.ts"

describe("GIT_GLOBAL_OPTS", () => {
  test("web copy matches hooks/utils/shell-patterns.ts", () => {
    expect(fromWeb).toBe(fromHooks)
  })
})
