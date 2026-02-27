import { describe, expect, it } from "vitest"
import {
  extractText,
  extractPlainTurns,
  countToolCalls,
  formatTurnsAsContext,
  isHookFeedback,
  projectKeyFromCwd,
  type PlainTurn,
} from "./transcript-utils.ts"

describe("transcript-utils.ts", () => {
  describe("extractText", () => {
    it("returns empty string for undefined content", () => {
      const result = extractText(undefined)
      expect(result).toBe("")
    })

    it("returns empty string for null-like content", () => {
      const result = extractText(undefined)
      expect(result).toBe("")
    })

    it("returns string content directly", () => {
      const content = "Test message"
      const result = extractText(content)
      expect(result).toBe(content)
    })

    it("extracts text from text blocks in array", () => {
      const content = [
        { type: "text" as const, text: "First" },
        { type: "text" as const, text: "Second" },
      ]
      const result = extractText(content)
      expect(result).toContain("First")
      expect(result).toContain("Second")
    })

    it("filters out non-text blocks", () => {
      const content = [
        { type: "text" as const, text: "Keep this" },
        { type: "tool_use", name: "Bash" },
      ]
      const result = extractText(content)
      expect(result).toContain("Keep this")
      expect(result).not.toContain("tool_use")
    })

    it("ignores text blocks with no text property", () => {
      const content = [{ type: "text" as const }]
      const result = extractText(content)
      expect(result).toBe("")
    })
  })

  describe("isHookFeedback", () => {
    it("returns false for non-string content", () => {
      const result = isHookFeedback([{ type: "text", text: "test" }])
      expect(result).toBe(false)
    })

    it("returns true for Stop hook feedback pattern", () => {
      const result = isHookFeedback("Stop hook feedback: test")
      expect(result).toBe(true)
    })

    it("returns true for command-message pattern", () => {
      const result = isHookFeedback("<command-message>test</command-message>")
      expect(result).toBe(true)
    })

    it("returns false for normal user messages", () => {
      const result = isHookFeedback("Just a normal message")
      expect(result).toBe(false)
    })

    it("returns false for undefined", () => {
      const result = isHookFeedback(undefined)
      expect(result).toBe(false)
    })
  })

  describe("projectKeyFromCwd", () => {
    it("converts slashes to hyphens", () => {
      const cwd = "/Users/test/project"
      const result = projectKeyFromCwd(cwd)
      expect(result).not.toContain("/")
      expect(result).toContain("-")
    })

    it("converts dots to hyphens", () => {
      const cwd = "project.name.test"
      const result = projectKeyFromCwd(cwd)
      expect(result).not.toContain(".")
      expect(result).toContain("-")
    })

    it("handles complex paths correctly", () => {
      const cwd = "/Users/matthewherod/Development/swiz"
      const result = projectKeyFromCwd(cwd)
      expect(typeof result).toBe("string")
      expect(result.length).toBeGreaterThan(0)
      // Should only contain alphanumeric and hyphens
      expect(/^[a-zA-Z0-9-]+$/.test(result)).toBe(true)
    })

    it("preserves alphanumeric characters", () => {
      const cwd = "project123"
      const result = projectKeyFromCwd(cwd)
      expect(result).toBe("project123")
    })
  })

  describe("extractPlainTurns", () => {
    it("parses JSONL formatted transcript lines", () => {
      const jsonl = '{"type":"user","message":{"content":"test"}}\n'
      const result = extractPlainTurns(jsonl)
      expect(Array.isArray(result)).toBe(true)
    })

    it("ignores malformed JSON lines", () => {
      const jsonl = '{"invalid json\n{"type":"user","message":{"content":"valid"}}\n'
      const result = extractPlainTurns(jsonl)
      expect(result.length).toBe(1)
    })

    it("filters out non-user/assistant entries", () => {
      const jsonl =
        '{"type":"system"}\n{"type":"user","message":{"content":"test"}}\n'
      const result = extractPlainTurns(jsonl)
      expect(result.length).toBe(1)
    })

    it("skips entries without message content", () => {
      const jsonl = '{"type":"user"}\n{"type":"user","message":{"content":"test"}}\n'
      const result = extractPlainTurns(jsonl)
      expect(result.length).toBe(1)
    })

    it("skips hook feedback messages", () => {
      const jsonl =
        '{"type":"user","message":{"content":"Stop hook feedback: test"}}\n{"type":"user","message":{"content":"normal"}}\n'
      const result = extractPlainTurns(jsonl)
      expect(result.length).toBe(1)
      expect(result[0]?.text).toBe("normal")
    })

    it("extracts text and tool summaries from assistant messages", () => {
      const jsonl = `{"type":"assistant","message":{"content":[{"type":"text","text":"analysis"},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}\n`
      const result = extractPlainTurns(jsonl)
      expect(result.length).toBe(1)
      expect(result[0]?.role).toBe("assistant")
      expect(result[0]?.text).toContain("analysis")
    })

    it("returns PlainTurn array with role and text", () => {
      const jsonl = '{"type":"user","message":{"content":"test message"}}\n'
      const result = extractPlainTurns(jsonl)
      expect(result[0]).toHaveProperty("role")
      expect(result[0]).toHaveProperty("text")
      expect(result[0]?.role).toBe("user")
      expect(result[0]?.text).toBe("test message")
    })
  })

  describe("countToolCalls", () => {
    it("returns 0 for empty JSONL", () => {
      const result = countToolCalls("")
      expect(result).toBe(0)
    })

    it("counts tool_use blocks in assistant messages", () => {
      const jsonl = `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}\n`
      const result = countToolCalls(jsonl)
      expect(result).toBeGreaterThanOrEqual(1)
    })

    it("ignores non-assistant messages", () => {
      const jsonl = `{"type":"user","message":{"content":[{"type":"tool_use","name":"Bash"}]}}\n`
      const result = countToolCalls(jsonl)
      expect(result).toBe(0)
    })

    it("counts multiple tool calls in single message", () => {
      const jsonl = `{"type":"assistant","message":{"content":[{"type":"tool_use"},{"type":"tool_use"}]}}\n`
      const result = countToolCalls(jsonl)
      expect(result).toBe(2)
    })

    it("handles malformed JSON gracefully", () => {
      const jsonl = `invalid json\n{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}\n`
      const result = countToolCalls(jsonl)
      expect(typeof result).toBe("number")
    })
  })

  describe("formatTurnsAsContext", () => {
    it("formats user and assistant turns as labeled conversation", () => {
      const turns: PlainTurn[] = [
        { role: "user", text: "Hello" },
        { role: "assistant", text: "Hi there" },
      ]
      const result = formatTurnsAsContext(turns)
      expect(result).toContain("User: Hello")
      expect(result).toContain("Assistant: Hi there")
    })

    it("joins turns with double newlines", () => {
      const turns: PlainTurn[] = [
        { role: "user", text: "First" },
        { role: "user", text: "Second" },
      ]
      const result = formatTurnsAsContext(turns)
      expect(result).toContain("\n\n")
    })

    it("returns empty string for empty turns", () => {
      const result = formatTurnsAsContext([])
      expect(result).toBe("")
    })

    it("labels user messages correctly", () => {
      const turns: PlainTurn[] = [{ role: "user", text: "test" }]
      const result = formatTurnsAsContext(turns)
      expect(result).toContain("User:")
    })

    it("labels assistant messages correctly", () => {
      const turns: PlainTurn[] = [{ role: "assistant", text: "test" }]
      const result = formatTurnsAsContext(turns)
      expect(result).toContain("Assistant:")
    })
  })

  describe("integration scenarios", () => {
    it("extracts and formats a complete conversation", () => {
      const jsonl =
        '{"type":"user","message":{"content":"What is 2+2?"}}\n' +
        '{"type":"assistant","message":{"content":"4"}}\n'
      const turns = extractPlainTurns(jsonl)
      const formatted = formatTurnsAsContext(turns)
      expect(formatted).toContain("User:")
      expect(formatted).toContain("What is 2+2?")
      expect(formatted).toContain("Assistant:")
    })

    it("counts tool calls in extracted turns", () => {
      const jsonl = `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}\n`
      const count = countToolCalls(jsonl)
      const turns = extractPlainTurns(jsonl)
      expect(turns.length).toBeGreaterThan(0)
      expect(count).toBeGreaterThanOrEqual(0)
    })

    it("handles complex transcript with mixed content", () => {
      const jsonl =
        '{"type":"user","message":{"content":"test"}}\n' +
        '{"type":"assistant","message":{"content":[{"type":"text","text":"response"},{"type":"tool_use","name":"Read"}]}}\n' +
        '{"type":"user","message":{"content":"Stop hook feedback: ignored"}}\n'
      const turns = extractPlainTurns(jsonl)
      const formatted = formatTurnsAsContext(turns)
      expect(turns.length).toBe(2) // Hook feedback excluded
      expect(formatted).toContain("User:")
      expect(formatted).toContain("Assistant:")
    })
  })

  describe("edge cases", () => {
    it("handles empty string content in text blocks", () => {
      const content = [{ type: "text" as const, text: "" }]
      const result = extractText(content)
      expect(result).toBe("")
    })

    it("handles whitespace-only text", () => {
      const content = "   "
      const result = extractText(content)
      expect(result).toBe("   ")
    })

    it("preserves multiline text", () => {
      const content = "Line 1\nLine 2\nLine 3"
      const result = extractText(content)
      expect(result).toContain("Line 1")
      expect(result).toContain("Line 2")
      expect(result).toContain("Line 3")
    })

    it("handles very long conversation transcripts", () => {
      const lines = Array(100)
        .fill(0)
        .map((_, i) => `{"type":"user","message":{"content":"message ${i}"}}`)
        .join("\n")
      const result = extractPlainTurns(lines)
      expect(result.length).toBe(100)
    })
  })
})
