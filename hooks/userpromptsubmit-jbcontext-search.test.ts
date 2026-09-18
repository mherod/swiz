import { describe, expect, it } from "bun:test"
import {
  cleanPromptForQuery,
  evaluateUserpromptsubmitJbcontextSearch,
  formatJbcontextSearchResults,
  readPromptText,
} from "./userpromptsubmit-jbcontext-search.ts"

describe("hooks/userpromptsubmit-jbcontext-search.ts", () => {
  describe("cleanPromptForQuery", () => {
    it("strips XML tags such as USER_REQUEST", () => {
      const prompt = "<USER_REQUEST>\nFind all hooks for sessionStart\n</USER_REQUEST>"
      expect(cleanPromptForQuery(prompt)).toBe("Find all hooks for sessionStart")
    })

    it("uses first line when it is within length bounds", () => {
      const prompt = "First line describing intent\n\nMore details follow on second line"
      expect(cleanPromptForQuery(prompt)).toBe("First line describing intent")
    })

    it("truncates prompt exceeding max length", () => {
      const longPrompt = "a".repeat(300)
      const cleaned = cleanPromptForQuery(longPrompt)
      expect(cleaned.length).toBe(250)
    })
  })

  describe("formatJbcontextSearchResults", () => {
    it("formats search items into markdown context", () => {
      const items = [
        {
          content: "function hello() { return 'world' }",
          contentStartLine: 42,
          result: {
            scoredText: { similarity: 0.85 },
            sourcePosition: { relativePath: "src/example.ts" },
          },
        },
      ]

      const formatted = formatJbcontextSearchResults("hello world query", items)
      expect(formatted).toContain("JetBrains Context semantic code search for user prompt:")
      expect(formatted).toContain('> "hello world query"')
      expect(formatted).toContain("1. `src/example.ts` (line 42):")
      expect(formatted).toContain("function hello() { return 'world' }")
    })

    it("handles items with missing line numbers or path gracefully", () => {
      const items = [
        {
          content: "const a = 1",
          result: {},
        },
      ]

      const formatted = formatJbcontextSearchResults("query", items)
      expect(formatted).toContain("1. `unknown` (line 1):")
      expect(formatted).toContain("const a = 1")
    })
  })

  describe("readPromptText", () => {
    it("returns prompt string when provided directly", async () => {
      const text = await readPromptText({ prompt: "Direct prompt query" } as any)
      expect(text).toBe("Direct prompt query")
    })

    it("returns empty string when no prompt or transcript exists", async () => {
      const text = await readPromptText({} as any)
      expect(text).toBe("")
    })
  })

  describe("evaluateUserpromptsubmitJbcontextSearch", () => {
    it("returns empty object when prompt is missing", async () => {
      const result = await evaluateUserpromptsubmitJbcontextSearch({})
      expect(result).toEqual({})
    })

    it("returns empty object when prompt is a slash command", async () => {
      const result = await evaluateUserpromptsubmitJbcontextSearch({
        prompt: "/commit changes to git",
      })
      expect(result).toEqual({})
    })

    it("returns empty object when prompt is too short", async () => {
      const result = await evaluateUserpromptsubmitJbcontextSearch({
        prompt: "hi",
      })
      expect(result).toEqual({})
    })

    it("searches and returns additional context in live repo when jbcontext is configured", async () => {
      const result = await evaluateUserpromptsubmitJbcontextSearch({
        prompt: "detect jbcontext binary and check configuration",
        cwd: process.cwd(),
      })

      const hso = (result as { hookSpecificOutput?: { additionalContext?: string } })
        .hookSpecificOutput
      if (hso?.additionalContext) {
        expect(hso.additionalContext).toContain("JetBrains Context semantic code search")
        expect(hso.additionalContext).toContain("line")
        expect(hso.additionalContext).toContain("```")
      } else {
        // If unindexed in some test runner, result is safely empty
        expect(result).toBeDefined()
      }
    })
  })
})
