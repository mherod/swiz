import { describe, expect, mock, test } from "bun:test"
import { join } from "node:path"
import { acquireEnvLock, releaseEnvLockFn, useTempDir } from "../utils/test-utils.ts"
import { humaniseHookContext } from "./context-humanise.ts"

const temp = useTempDir("swiz-humanise-context-")

describe("hook context humanising", () => {
  test("uses the provider and cache while keeping exact fallback on backend failure", async () => {
    const dir = await temp.create()
    const environment = {
      AI_TEST_NO_BACKEND: "1",
      AI_TEST_TEXT_RESPONSE: "Please run `bun test` before proceeding.",
      AI_TEST_CAPTURE_FILE: join(dir, "prompt.txt"),
      AI_TEST_THROW: "0",
      GEMINI_TEST_THROW: "0",
      SWIZ_PROMPT_CACHE_DIR: join(dir, "cache"),
    }
    await acquireEnvLock()
    const original = new Map(Object.keys(environment).map((key) => [key, process.env[key]]))
    try {
      Object.assign(process.env, environment)
      const response = { systemMessage: "Run `bun test` before proceeding." }
      await humaniseHookContext(response, { enabled: true })
      expect(response.systemMessage).toBe(environment.AI_TEST_TEXT_RESPONSE)
      expect(await Bun.file(environment.AI_TEST_CAPTURE_FILE).text()).toContain(
        JSON.stringify("Run `bun test` before proceeding.")
      )
      process.env.AI_TEST_THROW = "1"
      response.systemMessage = "Run `bun test` before proceeding."
      await humaniseHookContext(response, { enabled: true })
      expect(response.systemMessage).toBe(environment.AI_TEST_TEXT_RESPONSE)
      response.systemMessage = "  Uncached context\n\t"
      await humaniseHookContext(response, { enabled: true })
      expect(response.systemMessage).toBe("  Uncached context\n\t")
    } finally {
      for (const [key, value] of original) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      releaseEnvLockFn()
    }
  })

  test("rewrites every visible field once without altering controls or metadata", async () => {
    const response = {
      decision: "block",
      resolution: "human-required",
      continue: false,
      suppressOutput: true,
      systemMessage: "Context",
      reason: "Denial",
      stopReason: "Stop",
      additionalContext: "Gemini context",
      updatedInput: { reason: "Input data" },
      hookExecutions: [{ stdoutSnippet: "Original diagnostic" }],
      _stopActions: [{ message: "Original finding" }],
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Denial",
        additionalContext: "Context",
        modifiedInput: { systemMessage: "Input data" },
      },
    }
    const before = structuredClone(response)
    const rewrite = mock(async (message: string) => `Natural: ${message}`)
    await humaniseHookContext(response, { enabled: true, rewrite })
    expect(rewrite).toHaveBeenCalledTimes(4)
    expect(response).toEqual({
      ...before,
      systemMessage: "Natural: Context",
      reason: "Natural: Denial",
      stopReason: "Natural: Stop",
      additionalContext: "Natural: Gemini context",
      hookSpecificOutput: {
        ...before.hookSpecificOutput,
        permissionDecisionReason: "Natural: Denial",
        additionalContext: "Natural: Context",
      },
    })
  })

  test("does not add fields or approve an advisory call", async () => {
    const response = { systemMessage: "Advice" }
    await humaniseHookContext(response, { enabled: true, rewrite: async () => "Please proceed." })
    expect(response).toEqual({ systemMessage: "Please proceed." })
  })

  test("disabled and empty responses make no provider calls", async () => {
    const rewrite = mock(async () => "Unexpected")
    for (const response of [{}, { systemMessage: " \n\t " }, { hookSpecificOutput: null }]) {
      const before = structuredClone(response)
      await humaniseHookContext(response, { enabled: true, rewrite })
      expect(response).toEqual(before)
    }
    const response = { systemMessage: "Keep original" }
    await humaniseHookContext(response, { enabled: false, rewrite })
    expect(response.systemMessage).toBe("Keep original")
    expect(rewrite).not.toHaveBeenCalled()
  })

  test.each(["", " \n "])("empty rewrite %j preserves original bytes", async (result) => {
    const response = { systemMessage: "  Original\n\nmessage.\t" }
    const before = structuredClone(response)
    await humaniseHookContext(response, { enabled: true, rewrite: async () => result })
    expect(response).toEqual(before)
  })

  test("provider failure preserves the original and other messages can still succeed", async () => {
    const response = { reason: "  Denied\n", systemMessage: "Details" }
    await humaniseHookContext(response, {
      enabled: true,
      rewrite: async (text) => {
        if (text.includes("Denied")) throw new Error("Provider unavailable")
        return "Natural details"
      },
    })
    expect(response).toEqual({ reason: "  Denied\n", systemMessage: "Natural details" })
  })

  test.each([
    "Run `bun run typecheck` before proceeding.",
    "Read src/settings/types.ts before proceeding.",
    "Read ~/.swiz/settings.json before proceeding.",
    "Visit https://github.com/mherod/swiz/issues/123 before proceeding.",
    "Run:\n```sh\nbun run typecheck\nbun run lint\n```",
  ])("rejects a rewrite that loses literal content: %s", async (original) => {
    const response: { systemMessage: string } = { systemMessage: original }
    await humaniseHookContext(response, { enabled: true, rewrite: async () => "Please proceed." })
    expect(response.systemMessage).toBe(original)
    await humaniseHookContext(response, {
      enabled: true,
      rewrite: async (text) => `Please: ${text}`,
    })
    expect(response.systemMessage).toBe(`Please: ${original}`)
  })

  test("pre-aborted requests make no provider calls", async () => {
    const rewrite = mock(async () => "Unexpected")
    const response = { systemMessage: "Original" }
    await humaniseHookContext(response, { enabled: true, signal: AbortSignal.abort(), rewrite })
    expect(rewrite).not.toHaveBeenCalled()
    expect(response.systemMessage).toBe("Original")
  })

  test.each([
    "timeout",
    "caller",
  ])("%s aborts hung providers without late mutation", async (kind) => {
    const controller = new AbortController()
    let finish: (text: string) => void = () => {}
    let providerSignal: AbortSignal | undefined
    const response = { systemMessage: "  Original\n", reason: "Other message" }
    const before = structuredClone(response)
    const pending = humaniseHookContext(response, {
      enabled: true,
      signal: controller.signal,
      timeoutMs: 20,
      rewrite: async (text, signal) => {
        providerSignal = signal
        if (text === "Other message") return "Finished rewrite"
        return new Promise<string>((resolve) => {
          finish = resolve
        })
      },
    })
    if (kind === "caller") controller.abort()
    await pending
    expect(providerSignal?.aborted).toBe(true)
    expect(response).toEqual(before)
    finish("Late rewrite")
    await Promise.resolve()
    expect(response).toEqual(before)
  })
})
