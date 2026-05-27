import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearHumaniseCache,
  DEFAULT_HUMANISE_SYSTEM_PROMPT,
  fallbackHumaniseText,
  getInProgressTasksSnippet,
  getLastTranscriptMessage,
  humaniseText,
  lowerKnownImperative,
  PROMPT_CACHE_MAX_AGE_MS,
  PROMPT_CACHE_MAX_ENTRIES,
  promptCachePath,
  prunePromptDiskCache,
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

    describe("pruning", () => {
      test("prunePromptDiskCache removes entries older than the age threshold", async () => {
        const { dir, cleanup } = await withCacheDir()
        try {
          const fresh = promptCachePath("fresh prompt", dir)
          const stale = promptCachePath("stale prompt", dir)
          await writePromptDiskCache("fresh prompt", "fresh value", dir)
          await writePromptDiskCache("stale prompt", "stale value", dir)

          // Backdate the stale entry well past the age threshold.
          const old = new Date(Date.now() - PROMPT_CACHE_MAX_AGE_MS - 60_000)
          await utimes(stale, old, old)

          await prunePromptDiskCache(dir)

          expect(await Bun.file(fresh).exists()).toBe(true)
          expect(await Bun.file(stale).exists()).toBe(false)
        } finally {
          await cleanup()
        }
      })

      test("prunePromptDiskCache trims the oldest entries past the count cap", async () => {
        const { dir, cleanup } = await withCacheDir()
        try {
          const total = PROMPT_CACHE_MAX_ENTRIES + 5
          for (let i = 0; i < total; i++) {
            const path = promptCachePath(`prompt ${i}`, dir)
            await Bun.write(path, `value ${i}`)
            // Stagger mtimes so the lowest indices are oldest.
            const t = new Date(Date.now() - (total - i) * 1000)
            await utimes(path, t, t)
          }

          await prunePromptDiskCache(dir)

          // The 5 oldest (lowest indices) are evicted; the cap remains.
          expect(await Bun.file(promptCachePath("prompt 0", dir)).exists()).toBe(false)
          expect(await Bun.file(promptCachePath("prompt 4", dir)).exists()).toBe(false)
          expect(await Bun.file(promptCachePath("prompt 5", dir)).exists()).toBe(true)
          expect(await Bun.file(promptCachePath(`prompt ${total - 1}`, dir)).exists()).toBe(true)
        } finally {
          await cleanup()
        }
      })

      test("prunePromptDiskCache is best-effort on a missing directory", async () => {
        const { dir, cleanup } = await withCacheDir()
        try {
          const missing = join(dir, "does-not-exist")
          // Must resolve without throwing even when the dir is absent.
          await prunePromptDiskCache(missing)
          expect(true).toBe(true)
        } finally {
          await cleanup()
        }
      })

      test("writePromptDiskCache keeps the cache within the count cap", async () => {
        const { dir, cleanup } = await withCacheDir()
        try {
          // Pre-seed the cap with backdated entries so a fresh write evicts one.
          for (let i = 0; i < PROMPT_CACHE_MAX_ENTRIES; i++) {
            const path = promptCachePath(`seed ${i}`, dir)
            await Bun.write(path, `seed value ${i}`)
            const t = new Date(Date.now() - (PROMPT_CACHE_MAX_ENTRIES - i) * 1000)
            await utimes(path, t, t)
          }

          await writePromptDiskCache("newest prompt", "newest value", dir)

          // The newest write survives; the oldest seed was evicted to stay at cap.
          expect(await readPromptDiskCache("newest prompt", dir)).toBe("newest value")
          expect(await Bun.file(promptCachePath("seed 0", dir)).exists()).toBe(false)
        } finally {
          await cleanup()
        }
      })
    })

    describe("transcript context injection", () => {
      test("getLastTranscriptMessage returns null on missing or empty files", async () => {
        const { dir, cleanup } = await withCacheDir()
        try {
          const path = join(dir, "empty-transcript.jsonl")
          expect(await getLastTranscriptMessage(path)).toBeNull()
        } finally {
          await cleanup()
        }
      })

      test("getLastTranscriptMessage extracts the last valid user/assistant message", async () => {
        const { dir, cleanup } = await withCacheDir()
        try {
          const path = join(dir, "transcript.jsonl")
          const lines = [
            JSON.stringify({ type: "user", message: { content: "First user prompt" } }),
            JSON.stringify({ type: "assistant", message: { content: "First assistant reply" } }),
            "", // empty line
            JSON.stringify({ type: "user", message: { content: "Second user prompt" } }),
            JSON.stringify({ type: "system", message: { content: "System message" } }), // should be ignored
            JSON.stringify({
              type: "user",
              message: { content: "Stop hook feedback: should be skipped" },
            }), // skipped
            JSON.stringify({ type: "user", message: { content: "Second user prompt normalized" } }),
          ]
          await Bun.write(path, lines.join("\n"))

          const lastMsg = await getLastTranscriptMessage(path)
          expect(lastMsg).not.toBeNull()
          expect(lastMsg?.role).toBe("user")
          expect(lastMsg?.text).toBe("Second user prompt normalized")
        } finally {
          await cleanup()
        }
      })

      test("getLastTranscriptMessage handles different JSON message schemas", async () => {
        const { dir, cleanup } = await withCacheDir()
        try {
          const path = join(dir, "transcript.jsonl")
          const lines = [JSON.stringify({ type: "assistant", content: "Flat content text" })]
          await Bun.write(path, lines.join("\n"))

          const lastMsg = await getLastTranscriptMessage(path)
          expect(lastMsg).not.toBeNull()
          expect(lastMsg?.role).toBe("assistant")
          expect(lastMsg?.text).toBe("Flat content text")
        } finally {
          await cleanup()
        }
      })

      test("humaniseText includes resolved transcript context in cache key and prompt", async () => {
        const { dir, cleanup } = await withCacheDir()
        try {
          const path = join(dir, "transcript.jsonl")
          const lines = [
            JSON.stringify({ type: "user", message: { content: "My specific context" } }),
          ]
          await Bun.write(path, lines.join("\n"))

          clearHumaniseCache()

          // We'll mock the OpenRouter call by writing to the disk cache with the prompt containing the context.
          // The prompt structure is: `${systemPrompt}${contextSnippet}\n\nText to rewrite:\n${trimmed}`
          const systemPrompt = "Custom System Prompt"
          const trimmedText = "Please implement that feature"
          const contextSnippet =
            "\n\nRelated Conversation Context (Last Message):\n[User]: My specific context"
          const expectedPrompt = `${systemPrompt}${contextSnippet}\n\nText to rewrite:\n${trimmedText}`

          // Pre-seed disk cache for the expected prompt with context
          await writePromptDiskCache(expectedPrompt, "Rewritten with context, thanks.", dir)

          const result = await humaniseText(trimmedText, {
            systemPrompt,
            transcriptPath: path,
            cacheDir: dir,
          })

          expect(result).toBe("Rewritten with context, thanks.")
        } finally {
          await cleanup()
        }
      })

      test("getInProgressTasksSnippet retrieves and formats in_progress tasks", async () => {
        const { dir, cleanup } = await withCacheDir()
        try {
          const sessionId = "my-test-session"
          const tasksDir = join(dir, ".claude", "tasks", sessionId)
          const { mkdir } = await import("node:fs/promises")
          await mkdir(tasksDir, { recursive: true })

          // Create an in_progress task and a pending task
          await Bun.write(
            join(tasksDir, "task1.json"),
            JSON.stringify({ id: "task1", subject: "Develop unit tests", status: "in_progress" })
          )
          await Bun.write(
            join(tasksDir, "task2.json"),
            JSON.stringify({ id: "task2", subject: "Refactor prompts", status: "pending" })
          )

          const snippet = await getInProgressTasksSnippet(sessionId, dir)
          expect(snippet).toContain("Active In-Progress Tasks:")
          expect(snippet).toContain("- #task1: Develop unit tests")
          expect(snippet).not.toContain("Refactor prompts")
        } finally {
          await cleanup()
        }
      })

      test("humaniseText includes both transcript context and in-progress tasks", async () => {
        const { dir, cleanup } = await withCacheDir()
        try {
          const sessionId = "my-test-session"
          const tasksDir = join(dir, ".claude", "tasks", sessionId)
          const { mkdir } = await import("node:fs/promises")
          await mkdir(tasksDir, { recursive: true })

          // Write task
          await Bun.write(
            join(tasksDir, "task-abc.json"),
            JSON.stringify({
              id: "task-abc",
              subject: "Write excellent tests",
              status: "in_progress",
            })
          )

          // Write transcript
          const transcriptPath = join(dir, "transcript.jsonl")
          const lines = [
            JSON.stringify({ type: "user", message: { content: "My specific context" } }),
          ]
          await Bun.write(transcriptPath, lines.join("\n"))

          clearHumaniseCache()

          const systemPrompt = "Custom System Prompt"
          const trimmedText = "Please implement that feature"

          const transcriptSnippet =
            "\n\nRelated Conversation Context (Last Message):\n[User]: My specific context"
          const taskSnippet = "\n\nActive In-Progress Tasks:\n- #task-abc: Write excellent tests"
          const contextSnippet = `${transcriptSnippet}${taskSnippet}`
          const expectedPrompt = `${systemPrompt}${contextSnippet}\n\nText to rewrite:\n${trimmedText}`

          // Pre-seed disk cache for the expected prompt with both contexts
          await writePromptDiskCache(expectedPrompt, "Rewritten with both context and tasks.", dir)

          const result = await humaniseText(trimmedText, {
            systemPrompt,
            transcriptPath,
            sessionId,
            homeDir: dir,
            cacheDir: dir,
          })

          expect(result).toBe("Rewritten with both context and tasks.")
        } finally {
          await cleanup()
        }
      })
    })
  })
})
