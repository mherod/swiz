import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  clearHumaniseCache,
  fallbackHumaniseText,
  humaniseText,
  lowerKnownImperative,
  sentenceCase,
  toSingleParagraph,
} from "./humanise.ts"

const AI_ENV_KEYS = ["AI_TEST_NO_BACKEND", "AI_TEST_TEXT_RESPONSE", "AI_PROVIDER"] as const

describe("generic humanise utility", () => {
  const originalAiEnv = new Map<string, string | undefined>()

  beforeEach(() => {
    clearHumaniseCache()
    for (const key of AI_ENV_KEYS) {
      originalAiEnv.set(key, process.env[key])
      delete process.env[key]
    }
    process.env.AI_TEST_NO_BACKEND = "1"
  })

  afterEach(() => {
    clearHumaniseCache()
    for (const key of AI_ENV_KEYS) {
      const value = originalAiEnv.get(key)
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    originalAiEnv.clear()
  })

  test("lowerKnownImperative converts imperative verbs to lowercase", () => {
    expect(lowerKnownImperative("Take the next task")).toBe("take the next task")
    expect(lowerKnownImperative("Run git status")).toBe("run git status")
    expect(lowerKnownImperative("Unknown verb here")).toBe("Unknown verb here")
  })

  test("sentenceCase adds period if missing", () => {
    expect(sentenceCase("hello")).toBe("hello.")
    expect(sentenceCase("hello.")).toBe("hello.")
    expect(sentenceCase("hello?")).toBe("hello?")
    expect(sentenceCase("hello!")).toBe("hello!")
    expect(sentenceCase("")).toBe("")
  })

  test("toSingleParagraph converts multi-line to a single paragraph", () => {
    const multiLine = `
      # Heading
      - First item
      - Second item
    `
    const result = toSingleParagraph(multiLine)
    expect(result).toBe("Heading First item Second item")
  })

  test("toSingleParagraph accepts a custom line stripper", () => {
    const multiLine = `
      strip: target line
      keep: another line
    `
    const stripper = (line: string) => {
      const trimmed = line.trim()
      if (trimmed.startsWith("strip:")) return ""
      return trimmed
    }
    const result = toSingleParagraph(multiLine, stripper)
    expect(result).toBe("keep: another line")
  })

  test("fallbackHumaniseText creates a polite instruction paragraph", () => {
    expect(fallbackHumaniseText("Take the next task")).toBe("Please take the next task.")
    expect(fallbackHumaniseText("Please take the next task")).toBe("Please take the next task.")
    expect(fallbackHumaniseText("Can you take the next task?")).toBe("Can you take the next task?")
  })

  test("humaniseText rewrites via provider when one is available", async () => {
    delete process.env.AI_TEST_NO_BACKEND
    process.env.AI_TEST_TEXT_RESPONSE = "Let's work on the next task."

    const result = await humaniseText("Take the next task")
    expect(result).toBe("Let's work on the next task.")
  })

  test("humaniseText uses local fallback when no provider is available", async () => {
    // process.env.AI_TEST_NO_BACKEND is set to "1" in beforeEach
    const result = await humaniseText("Take the next task")
    expect(result).toBe("Please take the next task.")
  })

  test("humaniseText caches resolved promises to avoid extra calls", async () => {
    delete process.env.AI_TEST_NO_BACKEND
    process.env.AI_TEST_TEXT_RESPONSE = "First response"

    const first = await humaniseText("unique prompt")
    process.env.AI_TEST_TEXT_RESPONSE = "Second response should be cached"
    const second = await humaniseText("unique prompt")

    expect(first).toBe("First response")
    expect(second).toBe("First response")
  })

  test("humaniseText returns original input for blank input", async () => {
    delete process.env.AI_TEST_NO_BACKEND
    process.env.AI_TEST_TEXT_RESPONSE = "rewritten"

    expect(await humaniseText("   ")).toBe("   ")
  })
})
