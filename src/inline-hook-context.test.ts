import { describe, expect, it, vi } from "vitest"
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

  it("rephrases mechanical context wording", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_710_000_000_000)
    try {
      const out = buildContextHookOutput("PostToolUse", "Continue in good task hygiene mode.")
      const taskContextRe =
        /^(Stay|Remain|Keep going|Proceed|Carry on) in (brilliant|perfect|satisfactory|excellent|solid|sound) task (practice|regulation|discipline|routine|stewardship) mode\.$/i
      const hookOut = out as {
        suppressOutput: boolean
        hookSpecificOutput: {
          hookEventName: string
          additionalContext: string
        }
        systemMessage: string
      }
      expect(hookOut.suppressOutput).toBe(true)
      expect(hookOut.hookSpecificOutput.hookEventName).toBe("PostToolUse")
      expect(hookOut.systemMessage).toMatch(taskContextRe)
      expect(hookOut.hookSpecificOutput.additionalContext).toBe(hookOut.systemMessage)
      expect(hookOut.hookSpecificOutput.additionalContext).toMatch(taskContextRe)
    } finally {
      nowSpy.mockRestore()
    }
  })
})
