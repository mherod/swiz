import { describe, expect, test } from "bun:test"
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

/**
 * Create a fresh, isolated cache directory for a single test and return it
 * alongside a cleanup callback. The dir is injected explicitly into the
 * disk-cache helpers, so tests never mutate the shared process env — which
 * would race under `bun test --concurrent`.
 */
async function withCacheDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-humanise-cache-"))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** Snapshot the AI test env so a single test can mutate it and restore after. */
function snapshotAiEnv(): () => void {
  const original = new Map<string, string | undefined>()
  for (const key of AI_ENV_KEYS) {
    original.set(key, process.env[key])
  }
  return () => {
    for (const key of AI_ENV_KEYS) {
      const value = original.get(key)
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

describe("generic humanise utility", () => {
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

  test("humaniseText returns original input for blank input", async () => {
    // Blank input returns before the provider/cache layer, so it needs no env.
    expect(await humaniseText("   ")).toBe("   ")
  })

  // All provider-dependent scenarios live in ONE test: it is the only test that
  // touches the shared AI_TEST_* env, so nothing else can race with it under
  // `bun test --concurrent`. Each scenario uses an isolated cache dir and a
  // cleared in-memory cache.
  test("humaniseText routes between provider, fallback, and caching", async () => {
    const restoreEnv = snapshotAiEnv()
    const provider = await withCacheDir()
    const fallback = await withCacheDir()
    const caching = await withCacheDir()
    try {
      // 1. Provider available → returns the provider's rewrite.
      clearHumaniseCache()
      delete process.env.AI_TEST_NO_BACKEND
      process.env.AI_TEST_TEXT_RESPONSE =
        "Great work so far! I noticed you haven't worked on the next task yet — please pick it up now, thanks."
      expect(await humaniseText("Take the next task", { cacheDir: provider.dir })).toBe(
        "Great work so far! I noticed you haven't worked on the next task yet — please pick it up now, thanks."
      )

      // 2. No provider → local polite fallback.
      clearHumaniseCache()
      delete process.env.AI_TEST_TEXT_RESPONSE
      process.env.AI_TEST_NO_BACKEND = "1"
      expect(await humaniseText("Take the next task", { cacheDir: fallback.dir })).toBe(
        "I noticed you haven't done this yet — please take the next task, thanks."
      )

      // 3. In-memory cache returns the first resolved value on repeat calls.
      clearHumaniseCache()
      delete process.env.AI_TEST_NO_BACKEND
      process.env.AI_TEST_TEXT_RESPONSE = "First response"
      const first = await humaniseText("unique prompt", { cacheDir: caching.dir })
      process.env.AI_TEST_TEXT_RESPONSE = "Second response should be cached"
      const second = await humaniseText("unique prompt", { cacheDir: caching.dir })
      expect(first).toBe("First response")
      expect(second).toBe("First response")
    } finally {
      restoreEnv()
      clearHumaniseCache()
      await Promise.all([provider.cleanup(), fallback.cleanup(), caching.cleanup()])
    }
  })

  describe("disk cache", () => {
    test("promptCachePath derives a stable .txt path from a hash of the prompt", async () => {
      const { dir, cleanup } = await withCacheDir()
      try {
        const a = promptCachePath("the same prompt", dir)
        const b = promptCachePath("the same prompt", dir)
        const c = promptCachePath("a different prompt", dir)

        expect(a).toBe(b)
        expect(a).not.toBe(c)
        expect(a.startsWith(dir)).toBe(true)
        expect(a.endsWith(".txt")).toBe(true)
        // 64-hex-char SHA-256 digest as the file name.
        expect(a).toMatch(/\/[0-9a-f]{64}\.txt$/)
      } finally {
        await cleanup()
      }
    })

    test("write then read round-trips a value and creates the cache dir", async () => {
      const { dir, cleanup } = await withCacheDir()
      // Point at a not-yet-created subdir to prove writePromptDiskCache mkdirs it.
      const nested = join(dir, "nested")
      try {
        expect(await readPromptDiskCache("missing prompt", nested)).toBe(null)

        await writePromptDiskCache("a prompt", "a humanised value", nested)
        expect(await readPromptDiskCache("a prompt", nested)).toBe("a humanised value")
      } finally {
        await cleanup()
      }
    })

    test("readPromptDiskCache returns null on a miss", async () => {
      const { dir, cleanup } = await withCacheDir()
      try {
        expect(await readPromptDiskCache("never written", dir)).toBe(null)
      } finally {
        await cleanup()
      }
    })

    test("humaniseText returns the disk-cached value before reaching the provider", async () => {
      const { dir, cleanup } = await withCacheDir()
      try {
        // The disk hit is checked before any provider call, so this is robust
        // regardless of the shared AI_TEST_* env state.
        const text = "Take the disk-cached task"
        await writePromptDiskCache(buildPrompt(text), "Cached on disk, thanks.", dir)
        clearHumaniseCache()

        const result = await humaniseText(text, { cacheDir: dir })
        expect(result).toBe("Cached on disk, thanks.")
      } finally {
        await cleanup()
      }
    })
  })
})
