import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { z } from "zod"
import {
  activeProvider,
  hasAiProvider,
  promptObject,
  promptStreamText,
  promptText,
} from "./ai-providers.ts"

const envKeys = [
  "AI_PROVIDER",
  "AI_TEST_NO_BACKEND",
  "AI_TEST_RESPONSE",
  "AI_TEST_TEXT_RESPONSE",
  "AI_TEST_THROW",
  "GEMINI_API_KEY",
  "GEMINI_TEST_NO_BACKEND",
  "GEMINI_TEST_RESPONSE",
  "GEMINI_TEST_TEXT_RESPONSE",
  "GEMINI_TEST_STREAM_RESPONSE",
  "GEMINI_TEST_THROW",
  "OPENROUTER_API_KEY",
] as const
let saved: Array<string | undefined>
let which: ReturnType<typeof spyOn<typeof Bun, "which">>
const installed = new Set<string>()

beforeEach(() => {
  saved = envKeys.map((key) => process.env[key])
  for (const key of envKeys) delete process.env[key]
  installed.clear()
  which = spyOn(Bun, "which").mockImplementation((name) =>
    installed.has(name) ? `/fixture/${name}` : null
  )
})

afterEach(() => {
  which.mockRestore()
  envKeys.forEach((key, index) => {
    const value = saved[index]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
})

describe("provider selection policy", () => {
  test("uses live availability in priority order down to agy", () => {
    for (const name of ["codex", "claude", "gemini", "agy"]) installed.add(name)
    process.env.OPENROUTER_API_KEY = "test-key"
    expect(activeProvider()).toBe("codex")
    installed.delete("codex")
    expect(activeProvider()).toBe("openrouter")
    delete process.env.OPENROUTER_API_KEY
    expect(activeProvider()).toBe("claude")
    installed.delete("claude")
    expect(activeProvider()).toBe("gemini")
    installed.delete("gemini")
    expect(activeProvider()).toBe("agy")
    expect(hasAiProvider()).toBe(true)
    installed.clear()
    expect(activeProvider()).toBeNull()
    expect(hasAiProvider()).toBe(false)
  })

  test("explicit selection overrides the environment without silently falling back", () => {
    installed.add("codex")
    installed.add("agy")
    process.env.AI_PROVIDER = "codex"
    expect(activeProvider("agy")).toBe("agy")
    installed.delete("agy")
    expect(() => activeProvider("agy")).toThrow("AI_PROVIDER=agy requested but")
    process.env.AI_TEST_NO_BACKEND = "1"
    expect(activeProvider("agy")).toBeNull()
    expect(hasAiProvider()).toBe(false)
  })

  test("rejects prototype property names as unknown providers", () => {
    process.env.AI_PROVIDER = "toString"
    expect(() => activeProvider()).toThrow('Unknown AI provider "toString"')
  })

  test("shared prompt preflight preserves each API's validation context", async () => {
    process.env.GEMINI_API_KEY = "test-key"
    const options = { provider: "gemini" as const, model: "invalid-model" }
    await expect(promptText("test", options)).rejects.toThrow("promptText(options.model)")
    await expect(promptStreamText("test", options)).rejects.toThrow(
      "promptStreamText(options.model)"
    )
    await expect(promptObject("test", z.object({}), options)).rejects.toThrow(
      "promptObject(options.model)"
    )
  })
})
