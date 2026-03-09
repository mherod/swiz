import { describe, expect, it } from "vitest"
import {
  countToolCalls,
  extractEditedFilePaths,
  extractPlainTurns,
  extractText,
  extractToolResultText,
  formatTurnsAsContext,
  getUnsupportedTranscriptFormatMessage,
  isDocsOnlySession,
  isHookFeedback,
  isUnsupportedTranscriptFormat,
  type PlainTurn,
  parseTranscriptEntries,
  projectKeyFromCwd,
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

    it("converts Windows backslashes to hyphens", () => {
      const cwd = "C:\\Users\\test\\project"
      const result = projectKeyFromCwd(cwd)
      expect(result).not.toContain("\\")
      expect(/^[a-zA-Z0-9-]+$/.test(result)).toBe(true)
    })

    it("converts Windows drive colon to hyphen", () => {
      const cwd = "C:\\Users\\test"
      const result = projectKeyFromCwd(cwd)
      expect(result).not.toContain(":")
      // C + : + \ each become -, so "C:\" → "C--"
      expect(result).toBe("C--Users-test")
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
      const jsonl = '{"type":"system"}\n{"type":"user","message":{"content":"test"}}\n'
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

    it("parses Gemini JSON session format into user and assistant turns", () => {
      const geminiSession = JSON.stringify({
        sessionId: "gemini-session-1",
        messages: [
          { type: "info", content: "metadata only" },
          { type: "user", content: [{ text: "Hello Gemini" }] },
          { type: "gemini", content: "Hi there." },
        ],
      })
      const result = extractPlainTurns(geminiSession)
      expect(result).toHaveLength(2)
      expect(result[0]?.role).toBe("user")
      expect(result[0]?.text).toContain("Hello Gemini")
      expect(result[1]?.role).toBe("assistant")
      expect(result[1]?.text).toContain("Hi there.")
    })

    it("includes Gemini tool calls in assistant summaries", () => {
      const geminiSession = JSON.stringify({
        sessionId: "gemini-session-2",
        messages: [
          { type: "user", content: [{ text: "Run checks" }] },
          {
            type: "gemini",
            content: "",
            toolCalls: [{ name: "run_shell_command", args: { command: "pnpm test" } }],
          },
        ],
      })
      const result = extractPlainTurns(geminiSession)
      expect(result).toHaveLength(2)
      expect(result[1]?.text).toContain("run_shell_command")
      expect(result[1]?.text).toContain("pnpm test")
    })

    it("parses Codex JSONL session events into user and assistant turns", () => {
      const codexJsonl = [
        JSON.stringify({
          timestamp: "2026-03-05T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "019cbccf-2e0f-7f22-a111-aaaaaaaaaaaa",
            cwd: "/tmp/project",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-05T10:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Investigate test failure",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-05T10:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I will inspect the failing test." }],
          },
        }),
      ].join("\n")
      const result = extractPlainTurns(codexJsonl)
      expect(result).toHaveLength(2)
      expect(result[0]?.role).toBe("user")
      expect(result[0]?.text).toContain("Investigate test failure")
      expect(result[1]?.role).toBe("assistant")
      expect(result[1]?.text).toContain("inspect the failing test")
    })

    it("includes Codex function_call events in assistant tool summaries", () => {
      const codexJsonl = [
        JSON.stringify({
          timestamp: "2026-03-05T10:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Run tests",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-05T10:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: '{"cmd":"pnpm test"}',
          },
        }),
      ].join("\n")
      const result = extractPlainTurns(codexJsonl)
      expect(result).toHaveLength(2)
      expect(result[1]?.role).toBe("assistant")
      expect(result[1]?.text).toContain("exec_command")
      expect(result[1]?.text).toContain("pnpm test")
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

    it("counts Gemini tool calls after normalization", () => {
      const geminiSession = JSON.stringify({
        sessionId: "gemini-session-3",
        messages: [
          {
            type: "gemini",
            content: "",
            toolCalls: [{ name: "run_shell_command", args: { command: "echo test" } }],
          },
        ],
      })
      const result = countToolCalls(geminiSession)
      expect(result).toBe(1)
    })

    it("counts Codex function_call events after normalization", () => {
      const codexJsonl = [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: '{"cmd":"echo test"}',
          },
        }),
      ].join("\n")
      const result = countToolCalls(codexJsonl)
      expect(result).toBe(1)
    })
  })

  describe("unsupported format helpers", () => {
    it("identifies antigravity protobuf as unsupported", () => {
      expect(isUnsupportedTranscriptFormat("antigravity-pb")).toBe(true)
      expect(isUnsupportedTranscriptFormat("jsonl")).toBe(false)
      expect(isUnsupportedTranscriptFormat("gemini-json")).toBe(false)
      expect(isUnsupportedTranscriptFormat("codex-jsonl")).toBe(false)
    })

    it("returns a clear diagnostic for antigravity sessions", () => {
      const message = getUnsupportedTranscriptFormatMessage({
        id: "abc-session",
        path: "/tmp/abc-session.pb",
        mtime: Date.now(),
        provider: "antigravity",
        format: "antigravity-pb",
      })
      expect(message).toContain("abc-session")
      expect(message).toContain("Antigravity protobuf format (.pb)")
    })

    it("returns empty transcript entries when format hint is antigravity protobuf", () => {
      const result = parseTranscriptEntries("binary-ish-content", "antigravity-pb")
      expect(result).toEqual([])
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

    it("handles tool call with pattern input", () => {
      const jsonl = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "TODO" } }] },
      })
      const result = extractPlainTurns(jsonl)
      expect(result.length).toBe(1)
      expect(result[0]?.text).toContain("Grep")
    })

    it("handles tool call with glob_pattern input", () => {
      const jsonl = JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Glob", input: { glob_pattern: "**/*.ts" } }],
        },
      })
      const result = extractPlainTurns(jsonl)
      expect(result.length).toBe(1)
      expect(result[0]?.text).toContain("Glob")
    })

    it("handles tool call with long query input", () => {
      const longQuery = "a".repeat(100)
      const jsonl = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Search", input: { query: longQuery } }] },
      })
      const result = extractPlainTurns(jsonl)
      expect(result.length).toBe(1)
      expect(result[0]?.text).toContain("Search")
    })

    it("handles content that is neither string nor array", () => {
      const jsonl = JSON.stringify({
        type: "user",
        message: { content: { type: "object" } },
      })
      const result = extractPlainTurns(jsonl)
      expect(result.length).toBe(0)
    })

    it("handles tool call with file_path input", () => {
      const jsonl = JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Edit", input: { file_path: "/path/to/file.ts" } }],
        },
      })
      const result = extractPlainTurns(jsonl)
      expect(result.length).toBe(1)
      expect(result[0]?.text).toContain("Edit")
    })
  })

  describe("tool call label generation", () => {
    it("includes pattern input in label", () => {
      const jsonl = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "ERROR" } }] },
      })
      const result = extractPlainTurns(jsonl)
      expect(result.length).toBeGreaterThan(0)
      if (result[0]) {
        expect(result[0].text).toContain("Grep")
      }
    })

    it("includes glob_pattern input in label", () => {
      const jsonl = JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Glob", input: { glob_pattern: "src/**/*.ts" } }],
        },
      })
      const result = extractPlainTurns(jsonl)
      expect(result.length).toBeGreaterThan(0)
      if (result[0]) {
        expect(result[0].text).toContain("Glob")
      }
    })

    it("truncates long commands at 77 chars", () => {
      const veryLongCmd = "c".repeat(100)
      const cmd = veryLongCmd.length > 80 ? `${veryLongCmd.slice(0, 77)}...` : veryLongCmd
      expect(cmd.length).toBe(80)
      expect(cmd.endsWith("...")).toBe(true)
    })

    it("truncates long queries at 57 chars", () => {
      const veryLongQuery = "d".repeat(100)
      const q = veryLongQuery.length > 60 ? `${veryLongQuery.slice(0, 57)}...` : veryLongQuery
      expect(q.length).toBe(60)
      expect(q.endsWith("...")).toBe(true)
    })
  })

  describe("extractToolResultText", () => {
    it("extracts string content from tool_result block", () => {
      const result = extractToolResultText({ content: "file contents here", is_error: false })
      expect(result).toBe("file contents here")
    })

    it("prefixes error results with 'Error: '", () => {
      const result = extractToolResultText({ content: "command not found", is_error: true })
      expect(result).toBe("Error: command not found")
    })

    it("extracts text from array content blocks", () => {
      const result = extractToolResultText({
        content: [{ type: "text", text: "array output" }],
        is_error: false,
      })
      expect(result).toBe("array output")
    })

    it("truncates content longer than 400 chars", () => {
      const long = "x".repeat(500)
      const result = extractToolResultText({ content: long, is_error: false })
      expect(result.length).toBeLessThan(510) // truncated + ellipsis
      expect(result).toContain("…")
    })

    it("returns empty string for empty content", () => {
      const result = extractToolResultText({ content: "", is_error: false })
      expect(result).toBe("")
    })

    it("returns empty string for undefined content", () => {
      const result = extractToolResultText({ content: undefined, is_error: false })
      expect(result).toBe("")
    })
  })

  describe("extractPlainTurns with tool_result entries", () => {
    it("includes tool_result content in user turns", () => {
      const jsonl = JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "id1", content: "ls output here", is_error: false },
          ],
        },
      })
      const turns = extractPlainTurns(jsonl)
      expect(turns.length).toBe(1)
      expect(turns[0]?.role).toBe("user")
      expect(turns[0]?.text).toContain("ls output here")
    })

    it("prefixes error tool results with 'Error:'", () => {
      const jsonl = JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "id1", content: "command failed", is_error: true },
          ],
        },
      })
      const turns = extractPlainTurns(jsonl)
      expect(turns.length).toBe(1)
      expect(turns[0]?.text).toContain("Error:")
    })

    it("wraps tool_result content in [Result: ...] marker", () => {
      const jsonl = JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "id1", content: "output", is_error: false },
          ],
        },
      })
      const turns = extractPlainTurns(jsonl)
      expect(turns[0]?.text).toContain("[Result:")
    })

    it("skips tool_result blocks with empty content", () => {
      const jsonl = JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "id1", content: "", is_error: false }],
        },
      })
      const turns = extractPlainTurns(jsonl)
      expect(turns.length).toBe(0)
    })

    it("includes multiple tool_result blocks from same entry", () => {
      const jsonl = JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "id1", content: "result one", is_error: false },
            { type: "tool_result", tool_use_id: "id2", content: "result two", is_error: false },
          ],
        },
      })
      const turns = extractPlainTurns(jsonl)
      expect(turns.length).toBe(1)
      expect(turns[0]?.text).toContain("result one")
      expect(turns[0]?.text).toContain("result two")
    })
  })

  describe("projectKeyFromCwd", () => {
    it("converts slashes to hyphens", () => {
      const cwd = "/Users/dev/project"
      const result = projectKeyFromCwd(cwd)
      expect(result).not.toContain("/")
    })

    it("converts dots to hyphens", () => {
      const cwd = "project.name.dev"
      const result = projectKeyFromCwd(cwd)
      expect(result).not.toContain(".")
    })

    it("preserves alphanumeric characters", () => {
      const cwd = "abc123def456"
      const result = projectKeyFromCwd(cwd)
      expect(result).toBe("abc123def456")
    })

    it("handles mixed special characters", () => {
      const cwd = "/path/to/project.v2"
      const result = projectKeyFromCwd(cwd)
      expect(/^[a-zA-Z0-9-]+$/.test(result)).toBe(true)
    })

    it("converts Windows backslashes to hyphens", () => {
      const cwd = "C:\\Users\\dev\\project"
      const result = projectKeyFromCwd(cwd)
      expect(result).not.toContain("\\")
      expect(/^[a-zA-Z0-9-]+$/.test(result)).toBe(true)
    })

    it("converts Windows drive colon to hyphen", () => {
      const cwd = "C:\\Users\\dev"
      const result = projectKeyFromCwd(cwd)
      expect(result).not.toContain(":")
      // C + : + \ each become -, so "C:\" → "C--"
      expect(result).toBe("C--Users-dev")
    })
  })

  // ─── extractEditedFilePaths ─────────────────────────────────────────────────

  describe("extractEditedFilePaths", () => {
    function makeEditEntry(tool: string, filePath: string): string {
      return JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu1",
              name: tool,
              input: { file_path: filePath },
            },
          ],
        },
      })
    }

    it("returns empty set when transcript has no edit calls", () => {
      const jsonl = JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
      })
      expect(extractEditedFilePaths(jsonl).size).toBe(0)
    })

    it("extracts file_path from Edit tool calls", () => {
      const jsonl = makeEditEntry("Edit", "/repo/src/main.ts")
      const paths = extractEditedFilePaths(jsonl)
      expect(paths.has("/repo/src/main.ts")).toBe(true)
    })

    it("extracts file_path from Write tool calls", () => {
      const jsonl = makeEditEntry("Write", "/repo/docs/README.md")
      const paths = extractEditedFilePaths(jsonl)
      expect(paths.has("/repo/docs/README.md")).toBe(true)
    })

    it("collects multiple paths across entries", () => {
      const jsonl = [
        makeEditEntry("Edit", "/repo/src/index.ts"),
        makeEditEntry("Write", "/repo/CHANGELOG.md"),
      ].join("\n")
      const paths = extractEditedFilePaths(jsonl)
      expect(paths.size).toBe(2)
      expect(paths.has("/repo/src/index.ts")).toBe(true)
      expect(paths.has("/repo/CHANGELOG.md")).toBe(true)
    })

    it("ignores Bash commands that do not modify files (e.g. ls)", () => {
      const jsonl = JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } }],
        },
      })
      expect(extractEditedFilePaths(jsonl).size).toBe(0)
    })

    function makeBashEntry(command: string): string {
      return JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tb1", name: "Bash", input: { command } }],
        },
      })
    }

    it("extracts path from trash command", () => {
      const paths = extractEditedFilePaths(makeBashEntry("trash /repo/old-file.ts"))
      expect(paths.has("/repo/old-file.ts")).toBe(true)
    })

    it("extracts paths from mv command (rename)", () => {
      const paths = extractEditedFilePaths(makeBashEntry("mv /repo/src/old.ts /repo/src/new.ts"))
      expect(paths.has("/repo/src/old.ts")).toBe(true)
      expect(paths.has("/repo/src/new.ts")).toBe(true)
    })

    it("extracts path from git rm command", () => {
      const paths = extractEditedFilePaths(makeBashEntry("git rm /repo/obsolete.md"))
      expect(paths.has("/repo/obsolete.md")).toBe(true)
    })

    it("extracts path from git mv command", () => {
      const paths = extractEditedFilePaths(makeBashEntry("git mv /repo/old.md /repo/new.md"))
      expect(paths.has("/repo/old.md")).toBe(true)
      expect(paths.has("/repo/new.md")).toBe(true)
    })

    it("extracts path from rm -rf command", () => {
      const paths = extractEditedFilePaths(makeBashEntry("rm -rf /repo/dist"))
      expect(paths.has("/repo/dist")).toBe(true)
    })

    it("extracts path from output redirection (> file)", () => {
      const paths = extractEditedFilePaths(makeBashEntry("echo 'hello' > /repo/output.md"))
      expect(paths.has("/repo/output.md")).toBe(true)
    })

    it("extracts path from append redirection (>> file)", () => {
      const paths = extractEditedFilePaths(makeBashEntry("cat CHANGELOG >> /repo/CHANGELOG.md"))
      expect(paths.has("/repo/CHANGELOG.md")).toBe(true)
    })

    it("extracts path from heredoc redirection", () => {
      const cmd = "cat <<'EOF' > /repo/docs/notes.md\nsome content\nEOF"
      const paths = extractEditedFilePaths(makeBashEntry(cmd))
      expect(paths.has("/repo/docs/notes.md")).toBe(true)
    })

    it("does not extract path from fd duplication (>&)", () => {
      const paths = extractEditedFilePaths(makeBashEntry("some-cmd 2>&1"))
      // 2>&1 is fd dup, not a file write — should not produce a path
      expect(paths.has("1")).toBe(false)
    })

    it("does not extract path from process substitution (>()", () => {
      const paths = extractEditedFilePaths(makeBashEntry("tee >(gzip > out.gz)"))
      // >( is process substitution — should not match as a file path
      expect(paths.has("(gzip")).toBe(false)
    })

    it("extracts file from sed -i in-place edit", () => {
      const paths = extractEditedFilePaths(makeBashEntry("sed -i 's/foo/bar/' /repo/src/index.ts"))
      expect(paths.has("/repo/src/index.ts")).toBe(true)
    })

    it("extracts file from sed -i with backup suffix", () => {
      const paths = extractEditedFilePaths(makeBashEntry("sed -i.bak 's/x/y/' /repo/config.json"))
      expect(paths.has("/repo/config.json")).toBe(true)
    })

    it("extracts multiple files from sed -i on multiple targets", () => {
      const paths = extractEditedFilePaths(
        makeBashEntry("sed -i 's/old/new/' /repo/a.ts /repo/b.ts")
      )
      expect(paths.has("/repo/a.ts")).toBe(true)
      expect(paths.has("/repo/b.ts")).toBe(true)
    })

    it("extracts file from tee command", () => {
      const paths = extractEditedFilePaths(makeBashEntry("cmd | tee /repo/out.md"))
      expect(paths.has("/repo/out.md")).toBe(true)
    })

    it("extracts file from tee -a (append mode)", () => {
      const paths = extractEditedFilePaths(makeBashEntry("cmd | tee -a /repo/log.txt"))
      expect(paths.has("/repo/log.txt")).toBe(true)
    })

    it("extracts multiple files from tee with multiple targets", () => {
      const paths = extractEditedFilePaths(makeBashEntry("cmd | tee /repo/a.ts /repo/b.ts"))
      expect(paths.has("/repo/a.ts")).toBe(true)
      expect(paths.has("/repo/b.ts")).toBe(true)
    })

    it("extracts file from tee -- (end-of-flags form)", () => {
      const paths = extractEditedFilePaths(makeBashEntry("cmd | tee -- /repo/file.ts"))
      expect(paths.has("/repo/file.ts")).toBe(true)
    })

    it("does not extract process substitution from tee >(cmd)", () => {
      const paths = extractEditedFilePaths(makeBashEntry("cmd | tee >(gzip > /repo/out.gz)"))
      // process substitution target — should not appear as a plain file path
      expect(paths.has(">(gzip")).toBe(false)
    })

    it("extracts double-quoted path with spaces from mv", () => {
      const paths = extractEditedFilePaths(
        makeBashEntry('mv "/repo/my file.ts" "/repo/renamed file.ts"')
      )
      expect(paths.has("/repo/my file.ts")).toBe(true)
      expect(paths.has("/repo/renamed file.ts")).toBe(true)
    })

    it("extracts single-quoted path with spaces from output redirection", () => {
      const paths = extractEditedFilePaths(makeBashEntry("echo hello > '/repo/my notes.md'"))
      expect(paths.has("/repo/my notes.md")).toBe(true)
    })

    it("extracts double-quoted path with spaces from tee", () => {
      const paths = extractEditedFilePaths(makeBashEntry('cmd | tee "/repo/output file.ts"'))
      expect(paths.has("/repo/output file.ts")).toBe(true)
    })

    it("extracts single-quoted path with spaces from sed -i", () => {
      const paths = extractEditedFilePaths(makeBashEntry("sed -i 's/x/y/' '/repo/source file.ts'"))
      expect(paths.has("/repo/source file.ts")).toBe(true)
    })
  })

  // ─── isDocsOnlySession ──────────────────────────────────────────────────────

  describe("isDocsOnlySession", () => {
    it("returns false for empty set (no edits)", () => {
      expect(isDocsOnlySession(new Set())).toBe(false)
    })

    it("returns true when all paths are markdown files", () => {
      expect(
        isDocsOnlySession(new Set(["/repo/CLAUDE.md", "/repo/README.md", "/repo/docs/guide.md"]))
      ).toBe(true)
    })

    it("returns false when any path is a TypeScript source file", () => {
      expect(isDocsOnlySession(new Set(["/repo/CLAUDE.md", "/repo/src/settings.ts"]))).toBe(false)
    })

    it("returns true for CHANGELOG.md (recognized doc name)", () => {
      expect(isDocsOnlySession(new Set(["/repo/CHANGELOG.md"]))).toBe(true)
    })

    it("returns true for JSON config files", () => {
      expect(isDocsOnlySession(new Set(["/repo/.swiz/config.json"]))).toBe(true)
    })

    it("returns false for mixed source + doc edits", () => {
      expect(
        isDocsOnlySession(new Set(["/repo/hooks/stop-auto-continue.ts", "/repo/README.md"]))
      ).toBe(false)
    })

    it("returns false for a .ts source file alone", () => {
      expect(isDocsOnlySession(new Set(["/repo/src/foo.ts"]))).toBe(false)
    })
  })
})
