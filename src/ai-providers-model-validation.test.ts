import { afterEach, describe, expect, test } from "bun:test"

const originalGeminiModel = process.env.GEMINI_MODEL

async function importFreshAiProviders() {
  return import(`./ai-providers.ts?cacheBust=${Date.now()}-${Math.random()}`)
}

afterEach(() => {
  if (originalGeminiModel === undefined) delete process.env.GEMINI_MODEL
  else process.env.GEMINI_MODEL = originalGeminiModel
})

describe("ai-providers startup model validation", () => {
  test("throws immediately for invalid GEMINI_MODEL", async () => {
    process.env.GEMINI_MODEL = "gemini-3-pro-low"
    await expect(importFreshAiProviders()).rejects.toThrow(
      'Invalid Gemini model "gemini-3-pro-low" from GEMINI_MODEL'
    )
  })

  test("accepts a known GEMINI_MODEL value", async () => {
    process.env.GEMINI_MODEL = "gemini-2.5-pro"
    await expect(importFreshAiProviders()).resolves.toBeDefined()
  })
})
