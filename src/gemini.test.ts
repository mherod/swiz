import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { z } from "zod"
import {
  ensureGeminiApiKey,
  hasGeminiApiKey,
  promptGemini,
  promptGeminiObject,
  promptGeminiStreamText,
} from "./gemini.ts"
import { acquireEnvLock, releaseEnvLockFn } from "./utils/test-utils.ts"

const oauthCalls: unknown[] = []
void mock.module("ai-sdk-provider-gemini-cli", () => ({
  createGeminiProvider: (options: unknown) => {
    oauthCalls.push(options)
    throw new Error("OAuth fixture reached")
  },
}))

const envKeys = [
  "GEMINI_API_KEY",
  "GEMINI_TEST_THROW",
  "GEMINI_TEST_RESPONSE",
  "GEMINI_TEST_TEXT_RESPONSE",
  "GEMINI_TEST_STREAM_RESPONSE",
  "GEMINI_TEST_CAPTURE_FILE",
  "GEMINI_TEST_NO_BACKEND",
] as const
const savedEnv = new Map<string, string | undefined>()
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
const requests: { url: string; init?: RequestInit }[] = []

function interceptHttp(implementation: (...args: Parameters<typeof fetch>) => Promise<Response>) {
  fetchSpy.mockImplementation(Object.assign(implementation, { preconnect: () => {} }))
}

function responseData(text: string) {
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  }
}

function respondWith(text: string) {
  interceptHttp(async (url, init) => {
    requests.push({ url: String(url), init })
    return Response.json(responseData(text))
  })
}

beforeEach(async () => {
  await acquireEnvLock()
  for (const key of envKeys) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  process.env.GEMINI_API_KEY = "fixture-key"
  requests.length = 0
  oauthCalls.length = 0
  fetchSpy = spyOn(globalThis, "fetch")
  interceptHttp(async () => {
    throw new Error("Unexpected HTTP request")
  })
})

afterEach(() => {
  mock.restore()
  for (const key of envKeys) {
    const value = savedEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  releaseEnvLockFn()
})

describe("Gemini API-key transport", () => {
  test.each([undefined, "gemini-2.5-pro"])("generates text with model %s", async (model) => {
    respondWith("  reply  ")
    expect(await promptGemini("hello", { model })).toBe("reply")
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${model ?? "gemini-flash-latest"}:generateContent`
    )
    expect(new Headers(requests[0]?.init?.headers).get("x-goog-api-key")).toBe("fixture-key")
    expect(JSON.parse(String(requests[0]?.init?.body)).contents).toEqual([
      { role: "user", parts: [{ text: "hello" }] },
    ])
    expect(oauthCalls).toHaveLength(0)
  })

  test("uses a Keychain key through the same transport", async () => {
    delete process.env.GEMINI_API_KEY
    spyOn(Bun.secrets, "get").mockResolvedValue("keychain-fixture")
    await ensureGeminiApiKey()
    respondWith("reply")
    expect(await promptGemini("hello")).toBe("reply")
    expect(new Headers(requests[0]?.init?.headers).get("x-goog-api-key")).toBe("keychain-fixture")
    expect(oauthCalls).toHaveLength(0)
  })

  test("requests structured output and validates the returned object", async () => {
    const schema = z.object({ count: z.number() })
    respondWith('{"count":42}')
    expect(await promptGeminiObject("count", schema)).toEqual({ count: 42 })
    const config = JSON.parse(String(requests[0]?.init?.body)).generationConfig
    expect(config.responseMimeType).toBe("application/json")
    expect(config.responseSchema.properties.count.type).toBe("number")
    respondWith('{"count":"wrong type"}')
    await expect(promptGeminiObject("count", schema)).rejects.toThrow()
    expect(oauthCalls).toHaveLength(0)
  })

  test("streams deltas while returning trimmed text", async () => {
    interceptHttp(async (url, init) => {
      requests.push({ url: String(url), init })
      const body = [" one", " two "]
        .map((text) => `data: ${JSON.stringify(responseData(text))}\n\n`)
        .join("")
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    })
    const parts: string[] = []
    expect(await promptGeminiStreamText("hello", { onTextPart: (part) => parts.push(part) })).toBe(
      "one two"
    )
    expect(parts).toEqual([" one", " two "])
    expect(requests[0]?.url).toContain(":streamGenerateContent?alt=sse")
    expect(oauthCalls).toHaveLength(0)
  })

  test.each(["caller", "timeout"])("propagates %s cancellation to HTTP", async (source) => {
    const caller = new AbortController()
    let transportAborted = false
    interceptHttp(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (!signal) throw new Error("Missing transport abort signal")
          const abort = () => {
            transportAborted = true
            reject(signal.reason)
          }
          if (signal.aborted) abort()
          else signal.addEventListener("abort", abort, { once: true })
          if (source === "caller") queueMicrotask(() => caller.abort())
        })
    )
    await expect(
      promptGemini("hello", source === "caller" ? { signal: caller.signal } : { timeout: 25 })
    ).rejects.toThrow()
    expect(transportAborted).toBe(true)
    expect(oauthCalls).toHaveLength(0)
  })
})

test("retains the cached OAuth fallback when no API key is configured", async () => {
  delete process.env.GEMINI_API_KEY
  spyOn(Bun, "which").mockReturnValue("/fixture/gemini")
  expect(hasGeminiApiKey()).toBe(true)
  await expect(promptGemini("hello")).rejects.toThrow("OAuth fixture reached")
  expect(oauthCalls).toEqual([{ authType: "oauth-personal" }])
  expect(fetchSpy).not.toHaveBeenCalled()
})
