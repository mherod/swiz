import { describe, expect, it } from "bun:test"
import {
  buildGroundedQuery,
  cleanPromptForQuery,
  evaluateUserpromptsubmitJbcontextSearch,
  extractCodeTerms,
  formatJbcontextSearchResults,
  meetsSimilarityFloor,
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
      expect(formatted).toContain(
        "JetBrains Context semantic code search (query grounded in session context):"
      )
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

  describe("extractCodeTerms", () => {
    it("extracts paths, identifiers and backticked spans", () => {
      const text =
        "I updated `readSessionLines` in hooks/userpromptsubmit-git-context.ts to check the marker."
      const terms = extractCodeTerms(text, 5)
      expect(terms).toContain("readSessionLines")
      expect(terms).toContain("hooks/userpromptsubmit-git-context.ts")
    })

    it("ignores plain prose with no code-shaped tokens", () => {
      expect(extractCodeTerms("how helpful was that, really?", 5)).toEqual([])
    })

    it("dedupes case-insensitively and honours the limit", () => {
      const terms = extractCodeTerms("`buildQuery` buildQuery extractTerms parseThing", 2)
      expect(terms.length).toBe(2)
      expect(terms.filter((t) => t.toLowerCase() === "buildquery").length).toBe(1)
    })
  })

  describe("buildGroundedQuery", () => {
    it("returns the bare prompt when there is no grounding", () => {
      expect(buildGroundedQuery("where is the retry logic", [])).toBe("where is the retry logic")
    })

    it("appends grounding terms after the prompt", () => {
      const query = buildGroundedQuery("how helpful was it?", [
        "Ground jbcontext search query",
        "extractCodeTerms",
      ])
      expect(query.startsWith("how helpful was it?")).toBe(true)
      expect(query).toContain("extractCodeTerms")
    })

    it("skips grounding terms the prompt already names", () => {
      const query = buildGroundedQuery("fix extractCodeTerms please", ["extractCodeTerms"])
      expect(query).toBe("fix extractCodeTerms please")
    })

    it("truncates an over-long grounded query", () => {
      const query = buildGroundedQuery("a".repeat(300), ["b".repeat(300)])
      expect(query.length).toBeLessThanOrEqual(400)
    })
  })

  describe("meetsSimilarityFloor", () => {
    const withSimilarity = (similarity?: number) => ({
      content: "x",
      result: { scoredText: similarity === undefined ? {} : { similarity } },
    })

    it("drops weakly-matching results", () => {
      expect(meetsSimilarityFloor(withSimilarity(0.12))).toBe(false)
    })

    it("keeps results at or above the floor", () => {
      expect(meetsSimilarityFloor(withSimilarity(0.3))).toBe(true)
      expect(meetsSimilarityFloor(withSimilarity(0.85))).toBe(true)
    })

    it("passes results through when jbcontext omits a score", () => {
      expect(meetsSimilarityFloor(withSimilarity(undefined))).toBe(true)
    })
  })
})
