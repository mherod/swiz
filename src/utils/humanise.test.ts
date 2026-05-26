import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearHumaniseCache,
  DEFAULT_HUMANISE_SYSTEM_PROMPT,
  fallbackHumaniseText,
  humaniseText,
  lowerKnownImperative,
  promptCachePath,
  readPromptDiskCache,
  sentenceCase,
  toSingleParagraph,
  writePromptDiskCache,
} from "./humanise.ts"

const AI_ENV_KEYS = ["AI_TEST_NO_BACKEND", "AI_TEST_TEXT_RESPONSE", "AI_PROVIDER"] as const

/** Build the exact provider prompt humaniseTextUncached derives for a given text. */
function buildPrompt(text: string): string {
  return `${DEFAULT_HUMANISE_SYSTEM_PROMPT}\n\nText to rewrite:\n${text.trim()}`
}

describe("generic humanise utility", () => {
  const originalAiEnv = new Map<string, string | undefined>()
  let cacheDir: string
  let originalCacheDir: string | undefined

  beforeEach(async () => {
    clearHumaniseCache()
    for (const key of AI_ENV_KEYS) {
      originalAiEnv.set(key, process.env[key])
      delete process.env[key]
    }
    process.env.AI_TEST_NO_BACKEND = "1"
    // Redirect the disk cache to a fresh temp dir so tests never touch ~/.swiz
    // and never share cached entries with one another.
    originalCacheDir = process.env.SWIZ_PROMPT_CACHE_DIR
    cacheDir = await mkdtemp(join(tmpdir(), "swiz-humanise-cache-"))
    process.env.SWIZ_PROMPT_CACHE_DIR = cacheDir
  })

  afterEach(async () => {
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
    if (originalCacheDir === undefined) {
      delete process.env.SWIZ_PROMPT_CACHE_DIR
    } else {
      process.env.SWIZ_PROMPT_CACHE_DIR = originalCacheDir
    }
    await rm(cacheDir, { recursive: true, force: true })
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
    expect(fallbackHumaniseText("Take the next task")).toBe(
      "I noticed you haven't done this yet — please take the next task, thanks."
    )
    expect(fallbackHumaniseText("Please take the next task")).toBe("Please take the next task.")
    expect(fallbackHumaniseText("Can you take the next task?")).toBe("Can you take the next task?")
  })

  test("humaniseText rewrites via provider when one is available", async () => {
    delete process.env.AI_TEST_NO_BACKEND
    process.env.AI_TEST_TEXT_RESPONSE =
      "Great work so far! I noticed you haven't worked on the next task yet — please pick it up now, thanks."

    const result = await humaniseText("Take the next task")
    expect(result).toBe(
      "Great work so far! I noticed you haven't worked on the next task yet — please pick it up now, thanks."
    )
  })

  test("humaniseText uses local fallback when no provider is available", async () => {
    // process.env.AI_TEST_NO_BACKEND is set to "1" in beforeEach
    const result = await humaniseText("Take the next task")
    expect(result).toBe("I noticed you haven't done this yet — please take the next task, thanks.")
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

  describe("disk cache", () => {
    test("promptCachePath derives a stable .txt path from a hash of the prompt", () => {
      const a = promptCachePath("the same prompt")
      const b = promptCachePath("the same prompt")
      const c = promptCachePath("a different prompt")

      expect(a).toBe(b)
      expect(a).not.toBe(c)
      expect(a.startsWith(cacheDir)).toBe(true)
      expect(a.endsWith(".txt")).toBe(true)
      // 64-hex-char SHA-256 digest as the file name.
      expect(a).toMatch(/\/[0-9a-f]{64}\.txt$/)
    })

    test("write then read round-trips a value and creates the cache dir", async () => {
      // Point at a not-yet-created subdir to prove writePromptDiskCache mkdirs it.
      process.env.SWIZ_PROMPT_CACHE_DIR = join(cacheDir, "nested")
      expect(await readPromptDiskCache("missing prompt")).toBe(null)

      await writePromptDiskCache("a prompt", "a humanised value")
      expect(await readPromptDiskCache("a prompt")).toBe("a humanised value")
    })

    test("readPromptDiskCache returns null on a miss", async () => {
      expect(await readPromptDiskCache("never written")).toBe(null)
    })

    test("humaniseText returns the disk-cached value across in-memory clears", async () => {
      // Provider unavailable (AI_TEST_NO_BACKEND set in beforeEach), so without a
      // disk hit this would fall back. Pre-seed the disk cache instead.
      await writePromptDiskCache(buildPrompt("Take the next task"), "Cached on disk, thanks.")
      clearHumaniseCache()

      const result = await humaniseText("Take the next task")
      expect(result).toBe("Cached on disk, thanks.")
    })

    test("humaniseText persists provider rewrites to disk", async () => {
      delete process.env.AI_TEST_NO_BACKEND
      process.env.AI_TEST_TEXT_RESPONSE = "A freshly rewritten paragraph, thanks."

      await humaniseText("Take the next task")

      const onDisk = await readPromptDiskCache(buildPrompt("Take the next task"))
      expect(onDisk).toBe("A freshly rewritten paragraph, thanks.")
    })
  })
})
