import { afterEach, describe, expect, test } from "bun:test"
import {
  activeProvider,
  hasAiProvider,
  promptObject,
  promptStreamText,
  promptText,
} from "./ai-providers.ts"

// ─── hasAiProvider / activeProvider ──────────────────────────────────────────

describe("hasAiProvider", () => {
  const origKey = process.env.GEMINI_API_KEY
  const origNoBackend = process.env.AI_TEST_NO_BACKEND

  afterEach(() => {
    if (origKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = origKey
    if (origNoBackend === undefined) delete process.env.AI_TEST_NO_BACKEND
    else process.env.AI_TEST_NO_BACKEND = origNoBackend
  })

  test("returns false when AI_TEST_NO_BACKEND=1", () => {
    process.env.AI_TEST_NO_BACKEND = "1"
    expect(hasAiProvider()).toBe(false)
  })

  test("returns true when GEMINI_API_KEY is set", () => {
    delete process.env.AI_TEST_NO_BACKEND
    process.env.GEMINI_API_KEY = "test-key"
    expect(hasAiProvider()).toBe(true)
  })
})

describe("activeProvider", () => {
  const origKey = process.env.GEMINI_API_KEY
  const origNoBackend = process.env.AI_TEST_NO_BACKEND
  const origAiProvider = process.env.AI_PROVIDER

  afterEach(() => {
    if (origKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = origKey
    if (origNoBackend === undefined) delete process.env.AI_TEST_NO_BACKEND
    else process.env.AI_TEST_NO_BACKEND = origNoBackend
    if (origAiProvider === undefined) delete process.env.AI_PROVIDER
    else process.env.AI_PROVIDER = origAiProvider
  })

  test("returns null when AI_TEST_NO_BACKEND=1", () => {
    process.env.AI_TEST_NO_BACKEND = "1"
    expect(activeProvider()).toBeNull()
  })

  test("returns 'gemini' when GEMINI_API_KEY is set", () => {
    delete process.env.AI_TEST_NO_BACKEND
    process.env.GEMINI_API_KEY = "test-key"
    expect(activeProvider()).toBe("gemini")
  })

  test("override argument takes precedence over auto-select", () => {
    delete process.env.AI_TEST_NO_BACKEND
    process.env.GEMINI_API_KEY = "test-key"
    // Codex unavailable in test env, but we can verify gemini override works
    expect(activeProvider("gemini")).toBe("gemini")
  })

  test("AI_PROVIDER=gemini env var selects gemini when available", () => {
    delete process.env.AI_TEST_NO_BACKEND
    process.env.GEMINI_API_KEY = "test-key"
    process.env.AI_PROVIDER = "gemini"
    expect(activeProvider()).toBe("gemini")
  })

  test("throws on unknown AI_PROVIDER value", () => {
    delete process.env.AI_TEST_NO_BACKEND
    process.env.AI_PROVIDER = "openai"
    expect(() => activeProvider()).toThrow("Unknown AI provider")
  })

  test("override argument throws on unknown provider value", () => {
    delete process.env.AI_TEST_NO_BACKEND
    // @ts-expect-error — testing invalid runtime value
    expect(() => activeProvider("openai")).toThrow("Unknown AI provider")
  })

  test("AI_PROVIDER=codex throws when codex CLI is not installed", () => {
    delete process.env.AI_TEST_NO_BACKEND
    process.env.AI_PROVIDER = "codex"
    // In this test environment codex is not installed — Bun.which("codex") returns null
    if (Bun.which("codex")) {
      // codex is installed on this machine — skip the unavailable check
      expect(activeProvider()).toBe("codex")
    } else {
      expect(() => activeProvider()).toThrow("codex CLI is not installed")
    }
  })

  test("AI_PROVIDER=claude is accepted as a valid provider ID", () => {
    delete process.env.AI_TEST_NO_BACKEND
    process.env.AI_PROVIDER = "claude"
    // claude CLI availability depends on the machine; just verify it doesn't throw "Unknown AI provider"
    if (Bun.which("claude")) {
      expect(activeProvider()).toBe("claude")
    } else {
      expect(() => activeProvider()).toThrow("claude CLI is not installed")
    }
  })

  test("override argument accepts claude", () => {
    delete process.env.AI_TEST_NO_BACKEND
    if (Bun.which("claude")) {
      expect(activeProvider("claude")).toBe("claude")
    } else {
      expect(() => activeProvider("claude")).toThrow("claude CLI is not installed")
    }
  })
})

// ─── promptText ───────────────────────────────────────────────────────────────

describe("promptText", () => {
  const origResponse = process.env.AI_TEST_TEXT_RESPONSE

  afterEach(() => {
    if (origResponse === undefined) delete process.env.AI_TEST_TEXT_RESPONSE
    else process.env.AI_TEST_TEXT_RESPONSE = origResponse
  })

  test("returns AI_TEST_TEXT_RESPONSE fixture when set", async () => {
    process.env.AI_TEST_TEXT_RESPONSE = "  hello world  "
    const result = await promptText("prompt")
    expect(result).toBe("hello world")
  })

  test("throws when no provider available", async () => {
    delete process.env.AI_TEST_TEXT_RESPONSE
    process.env.AI_TEST_NO_BACKEND = "1"
    try {
      await promptText("prompt")
      expect(true).toBe(false) // should not reach
    } catch (e: unknown) {
      expect((e as Error).message).toContain("No AI provider available")
    } finally {
      delete process.env.AI_TEST_NO_BACKEND
    }
  })
})

// ─── promptStreamText ─────────────────────────────────────────────────────────

describe("promptStreamText", () => {
  const origResponse = process.env.AI_TEST_TEXT_RESPONSE

  afterEach(() => {
    if (origResponse === undefined) delete process.env.AI_TEST_TEXT_RESPONSE
    else process.env.AI_TEST_TEXT_RESPONSE = origResponse
  })

  test("returns fixture and calls onTextPart when AI_TEST_TEXT_RESPONSE is set", async () => {
    process.env.AI_TEST_TEXT_RESPONSE = "streamed response"
    const parts: string[] = []
    const result = await promptStreamText("prompt", { onTextPart: (p) => parts.push(p) })
    expect(result).toBe("streamed response")
    expect(parts).toEqual(["streamed response"])
  })

  test("throws when no provider available", async () => {
    delete process.env.AI_TEST_TEXT_RESPONSE
    process.env.AI_TEST_NO_BACKEND = "1"
    try {
      await promptStreamText("prompt")
      expect(true).toBe(false)
    } catch (e: unknown) {
      expect((e as Error).message).toContain("No AI provider available")
    } finally {
      delete process.env.AI_TEST_NO_BACKEND
    }
  })
})

// ─── promptObject ─────────────────────────────────────────────────────────────

describe("promptObject", () => {
  const origResponse = process.env.AI_TEST_RESPONSE

  afterEach(() => {
    if (origResponse === undefined) delete process.env.AI_TEST_RESPONSE
    else process.env.AI_TEST_RESPONSE = origResponse
  })

  test("returns parsed AI_TEST_RESPONSE fixture when set", async () => {
    const { z } = await import("zod")
    const schema = z.object({ name: z.string() })
    process.env.AI_TEST_RESPONSE = JSON.stringify({ name: "test" })
    const result = await promptObject("prompt", schema)
    expect(result.name).toBe("test")
  })

  test("throws when no provider available", async () => {
    delete process.env.AI_TEST_RESPONSE
    process.env.AI_TEST_NO_BACKEND = "1"
    const { z } = await import("zod")
    const schema = z.object({ name: z.string() })
    try {
      await promptObject("prompt", schema)
      expect(true).toBe(false)
    } catch (e: unknown) {
      expect((e as Error).message).toContain("No AI provider available")
    } finally {
      delete process.env.AI_TEST_NO_BACKEND
    }
  })
})

// ─── Gemini provider fallback (GEMINI_TEST_* seams still work via gemini.ts) ──

describe("promptObject with Gemini test seam (GEMINI_TEST_RESPONSE)", () => {
  afterEach(() => {
    delete process.env.GEMINI_TEST_RESPONSE
    delete process.env.GEMINI_API_KEY
  })

  test("dispatches to Gemini when GEMINI_API_KEY is set and uses GEMINI_TEST_RESPONSE fixture", async () => {
    const { z } = await import("zod")
    const schema = z.object({ value: z.number() })
    process.env.GEMINI_API_KEY = "test-key"
    process.env.GEMINI_TEST_RESPONSE = JSON.stringify({ value: 42 })
    const result = await promptObject("prompt", schema)
    expect(result.value).toBe(42)
  })
})
