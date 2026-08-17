import { describe, expect, it } from "vitest"
import { parseJunieEvents } from "./transcript-analysis-parse-part1.ts"
import type { ContentBlock, TextBlock, ToolResultBlock } from "./transcript-schemas.ts"

function asContentBlocks(content: string | ContentBlock[] | undefined): ContentBlock[] {
  if (Array.isArray(content)) return content
  throw new Error(`Expected ContentBlock[], got ${typeof content}`)
}

describe("transcript-analysis-parse-part1.ts (Junie)", () => {
  describe("parseJunieEvents", () => {
    it("parses user prompts", () => {
      const jsonl = JSON.stringify({
        type: "event",
        timestamp: "2026-04-01T00:00:00Z",
        cwd: "/project",
        payload: { type: "user-prompt", content: "Hello Junie" },
      })
      const entries = parseJunieEvents(jsonl)
      expect(entries).toHaveLength(1)
      expect(entries[0]!.type).toBe("user")
      expect(entries[0]!.message?.role).toBe("user")
      expect(entries[0]!.message?.content).toBe("Hello Junie")
      expect(entries[0]!.timestamp).toBe("2026-04-01T00:00:00Z")
    })

    it("parses agent responses with text", () => {
      const jsonl = JSON.stringify({
        type: "event",
        payload: { type: "agent-response", content: "Hello human" },
      })
      const entries = parseJunieEvents(jsonl)
      expect(entries).toHaveLength(1)
      expect(entries[0]!.type).toBe("assistant")
      expect(entries[0]!.message?.content).toEqual([{ type: "text", text: "Hello human" }])
    })

    it("parses agent responses with tool calls", () => {
      const jsonl = JSON.stringify({
        type: "event",
        payload: {
          type: "agent-response",
          content: "Thinking...",
          tool_calls: [{ id: "call1", name: "Bash", input: { command: "ls" } }],
        },
      })
      const entries = parseJunieEvents(jsonl)
      expect(entries).toHaveLength(1)
      const content = asContentBlocks(entries[0]!.message?.content)
      expect(content).toHaveLength(2)
      expect(content[0]).toEqual({ type: "text", text: "Thinking..." })
      expect(content[1]).toEqual({
        type: "tool_use",
        id: "call1",
        name: "Bash",
        input: { command: "ls" },
      })
    })

    it("parses tool outputs", () => {
      const jsonl = JSON.stringify({
        type: "event",
        payload: {
          type: "tool-output",
          tool_call_id: "call1",
          content: "file1.txt",
          is_error: false,
        },
      })
      const entries = parseJunieEvents(jsonl)
      expect(entries).toHaveLength(1)
      expect(entries[0]!.type).toBe("user")
      const content = asContentBlocks(entries[0]!.message?.content)
      expect(content).toHaveLength(1)
      expect(content[0]).toEqual({
        type: "tool_result",
        tool_use_id: "call1",
        content: "file1.txt",
        is_error: false,
      })
    })

    it("ignores other event types", () => {
      const jsonl = JSON.stringify({
        type: "event",
        payload: { type: "system-message", content: "System boot" },
      })
      const entries = parseJunieEvents(jsonl)
      expect(entries).toHaveLength(0)
    })

    it("parses modern Junie stream events", () => {
      const jsonl = [
        JSON.stringify({
          kind: "UserPromptEvent",
          prompt: "Modern prompt",
          timestamp: "2026-04-01T10:00:00Z",
        }),
        JSON.stringify({
          kind: "SessionA2uxEvent",
          event: {
            state: "IN_PROGRESS",
            agentEvent: {
              kind: "MarkdownBlockUpdatedEvent",
              stepId: "step1",
              text: "Streaming thought",
            },
          },
          timestamp: "2026-04-01T10:00:01Z",
        }),
        JSON.stringify({
          kind: "SessionA2uxEvent",
          event: {
            state: "IN_PROGRESS",
            agentEvent: { kind: "ToolBlockUpdatedEvent", stepId: "step2", text: "Running tool" },
          },
          timestamp: "2026-04-01T10:00:02Z",
        }),
        JSON.stringify({
          kind: "SessionA2uxEvent",
          event: {
            state: "COMPLETED",
            agentEvent: { kind: "ResultBlockUpdatedEvent", stepId: "step2", output: "Tool output" },
          },
          timestamp: "2026-04-01T10:00:03Z",
        }),
      ].join("\n")

      const entries = parseJunieEvents(jsonl)
      expect(entries).toHaveLength(4)
      expect(entries[0]!.type).toBe("user")
      expect(entries[0]!.message?.content).toBe("Modern prompt")
      expect(entries[1]!.type).toBe("assistant")
      expect(entries[1]!.message?.content).toBe("Streaming thought")
      expect(entries[2]!.type).toBe("assistant")
      const entry2Content = asContentBlocks(entries[2]!.message?.content)
      expect((entry2Content[0] as TextBlock).text).toBe("Running tool")
      expect(entries[3]!.type).toBe("user")
      const entry3Content = asContentBlocks(entries[3]!.message?.content)
      expect((entry3Content[0] as ToolResultBlock).content).toBe("Tool output")
    })

    it("parses AgentThoughtBlockUpdatedEvent stream events", () => {
      const jsonl = JSON.stringify({
        kind: "SessionA2uxEvent",
        event: {
          state: "IN_PROGRESS",
          agentEvent: {
            kind: "AgentThoughtBlockUpdatedEvent",
            stepId: "step1",
            text: "Thought content",
          },
        },
        timestamp: "2026-04-01T10:00:01Z",
      })

      const entries = parseJunieEvents(jsonl)
      expect(entries).toHaveLength(1)
      expect(entries[0]!.type).toBe("assistant")
      expect(entries[0]!.message?.content).toBe("Thought content")
    })

    it("parses AgentStateUpdatedEvent blob history", () => {
      const blob = {
        lastAgentState: {
          issueDescription: [{ parts: [{ type: "text", text: "Issue description" }] }],
          history: [
            {
              kind: "Agent",
              parts: [{ type: "text", text: "History thought" }],
            },
          ],
        },
      }
      const jsonl = JSON.stringify({
        event: {
          agentEvent: {
            kind: "AgentStateUpdatedEvent",
            blob: JSON.stringify(blob),
          },
        },
      })

      const entries = parseJunieEvents(jsonl)
      // Should have 1 user message from issueDescription + 1 assistant message from history
      // Note: my implementation pushes them both.
      expect(entries).toHaveLength(2)
      expect(entries[0]!.type).toBe("user")
      expect(entries[1]!.type).toBe("assistant")
      const entry1Content = asContentBlocks(entries[1]!.message?.content)
      expect((entry1Content[0] as TextBlock).text).toBe("History thought")
    })
  })
})
