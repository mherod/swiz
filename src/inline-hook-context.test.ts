import { describe, expect, it } from "vitest"
import { SwizHookExit, withInlineSwizHookRun } from "./inline-hook-context.ts"
import { buildContextHookOutput, exitWithHookObject } from "./utils/hook-utils.ts"

describe("inline SwizHook context", () => {
  it("exitWithHookObject throws SwizHookExit carrying output when inline dispatch is active", async () => {
    const out = buildContextHookOutput("PostToolUse", "ctx")
    try {
      await withInlineSwizHookRun(async () => {
        exitWithHookObject(out)
      })
      expect.fail("expected SwizHookExit")
    } catch (e) {
      expect(e).toBeInstanceOf(SwizHookExit)
      expect((e as SwizHookExit).output).toEqual(out)
    }
  })
})
