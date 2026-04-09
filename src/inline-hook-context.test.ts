import { describe, expect, it } from "vitest"
import { SwizHookExit, withInlineSwizHookRun } from "./inline-hook-context.ts"
import { buildContextHookOutput, exitWithHookObject } from "./utils/hook-utils.ts"

describe("inline SwizHook context", () => {
  it("exitWithHookObject throws SwizHookExit carrying output when inline dispatch is active", async () => {
    const prevCodexThreadId = process.env.CODEX_THREAD_ID
    const prevCodexManagedByNpm = process.env.CODEX_MANAGED_BY_NPM
    delete process.env.CODEX_THREAD_ID
    delete process.env.CODEX_MANAGED_BY_NPM
    try {
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
    } finally {
      if (prevCodexThreadId === undefined) delete process.env.CODEX_THREAD_ID
      else process.env.CODEX_THREAD_ID = prevCodexThreadId
      if (prevCodexManagedByNpm === undefined) delete process.env.CODEX_MANAGED_BY_NPM
      else process.env.CODEX_MANAGED_BY_NPM = prevCodexManagedByNpm
    }
  })
})
