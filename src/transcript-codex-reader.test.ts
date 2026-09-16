import { describe, expect, it } from "vitest"
import { parseCodexJsonlEntries } from "./transcript-analysis-parse-part1.ts"
import {
  collectCurrentSessionUsageEvents,
  extractSessionLines,
  extractTranscriptData,
  parseTranscriptSummary,
} from "./transcript-utils.ts"

function codexResponseItem(payload: Record<string, unknown>): string {
  return JSON.stringify({
    type: "response_item",
    timestamp: "2026-07-31T12:00:00.000Z",
    payload,
  })
}

function codexUserMessage(message: string): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-31T12:00:00.000Z",
    payload: { type: "user_message", message },
  })
}

describe("Codex transcript reader", () => {
  it("reads current user messages with timestamps and session IDs", () => {
    const jsonl = [
      JSON.stringify({ type: "session_meta", payload: { id: "codex-user-session" } }),
      codexResponseItem({
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "First line" },
          { type: "input_image", image_url: "image-placeholder" },
          { type: "input_text", text: "Second line" },
        ],
      }),
    ].join("\n")

    expect(parseCodexJsonlEntries(jsonl)).toEqual([
      {
        type: "user",
        sessionId: "codex-user-session",
        timestamp: "2026-07-31T12:00:00.000Z",
        message: { role: "user", content: "First line\nSecond line" },
      },
    ])
  })

  it.each([false, true])("deduplicates paired user formats (legacy first: %s)", (legacyFirst) => {
    const current = codexResponseItem({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Continue" }],
    })
    const legacy = codexUserMessage("Continue")
    const pair = legacyFirst ? [legacy, current] : [current, legacy]
    const metadata = JSON.stringify({ type: "turn_context", payload: { cwd: "/workspace" } })
    const entries = parseCodexJsonlEntries([pair[0], metadata, pair[1], ...pair].join("\n"))

    expect(entries.map((entry) => entry.message?.content)).toEqual(["Continue", "Continue"])
    expect(parseCodexJsonlEntries([current, current].join("\n"))).toHaveLength(2)
    expect(parseCodexJsonlEntries([legacy, legacy].join("\n"))).toHaveLength(2)
  })

  it("keeps repeated requests after an assistant response", () => {
    const jsonl = [
      codexUserMessage("Continue"),
      codexResponseItem({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Done" }],
      }),
      codexResponseItem({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue" }],
      }),
    ].join("\n")

    expect(parseCodexJsonlEntries(jsonl).map((entry) => entry.type)).toEqual([
      "user",
      "assistant",
      "user",
    ])
  })

  it("keeps a repeated request in a new turn after an interruption", () => {
    const current = codexResponseItem({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Continue" }],
    })
    const nextTurn = JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })

    expect(
      parseCodexJsonlEntries([codexUserMessage("Continue"), nextTurn, current].join("\n"))
    ).toHaveLength(2)
  })

  it("ignores non-user instructions and user records without input text", () => {
    const records = [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Rules" }] },
      { type: "message", role: "system", content: [{ type: "input_text", text: "Rules" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "  " }] },
      { type: "message", role: "user", content: [{ type: "output_text", text: "Wrong type" }] },
      { type: "message", role: "user", content: null },
      { type: "function_call_output", output: "Tool output" },
    ]

    expect(parseCodexJsonlEntries(records.map(codexResponseItem).join("\n"))).toEqual([])
  })

  it("normalizes custom apply_patch calls and extracts every edited path", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/existing.ts",
      "@@",
      "-old",
      "+new",
      "*** Add File: src/added.ts",
      "+export const added = true",
      "*** Move to: src/moved.ts",
      "*** Delete File: src/removed.ts",
      "*** End Patch",
    ].join("\n")
    const jsonl = codexResponseItem({
      type: "custom_tool_call",
      name: "apply_patch",
      call_id: "call-patch",
      input: patch,
    })

    const data = extractTranscriptData(jsonl, "codex-jsonl")
    const summary = parseTranscriptSummary(jsonl)

    expect(data.toolCallCount).toBe(1)
    expect(data.turns.some((turn) => turn.text.includes("apply_patch"))).toBe(true)
    expect([...data.editedPaths]).toEqual([
      "src/existing.ts",
      "src/added.ts",
      "src/moved.ts",
      "src/removed.ts",
    ])
    expect(summary.toolNames).toEqual(["apply_patch"])
  })

  it("extracts shell edits from Codex exec_command calls", () => {
    const jsonl = codexResponseItem({
      type: "function_call",
      name: "exec_command",
      call_id: "call-exec-command",
      arguments: JSON.stringify({ cmd: "touch src/generated.ts" }),
    })

    const data = extractTranscriptData(jsonl, "codex-jsonl")

    expect(data.toolCallCount).toBe(1)
    expect([...data.editedPaths]).toEqual(["src/generated.ts"])
  })

  it("uses a top-level Codex compacted record as a session boundary", () => {
    const before = codexResponseItem({
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "bun run lint" }),
    })
    const boundary = JSON.stringify({ type: "compacted", payload: {} })
    const after = codexResponseItem({
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "bun test" }),
    })
    const jsonl = [before, boundary, after].join("\n")

    const lines = extractSessionLines(jsonl)
    const summary = parseTranscriptSummary(jsonl)

    expect(lines.some((line) => line.includes("bun run lint"))).toBe(false)
    expect(lines.some((line) => line.includes("bun test"))).toBe(true)
    expect(summary.bashCommands).toEqual(["bun test"])
  })

  it("uses a Codex context_compacted event as a session boundary", () => {
    const before = codexResponseItem({
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "bun run lint" }),
    })
    const boundary = JSON.stringify({
      type: "event_msg",
      payload: { type: "context_compacted" },
    })
    const after = codexResponseItem({
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "bun test" }),
    })

    const lines = extractSessionLines([before, boundary, after].join("\n"))

    expect(lines.some((line) => line.includes("bun run lint"))).toBe(false)
    expect(lines.some((line) => line.includes("bun test"))).toBe(true)
  })

  it("indexes Codex tool usage by user turns and includes custom tools", () => {
    const lines = [
      codexUserMessage("First request"),
      codexResponseItem({
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "bun test" }),
      }),
      codexUserMessage("Second request"),
      codexResponseItem({
        type: "custom_tool_call",
        name: "apply_patch",
        input: "*** Begin Patch\n*** End Patch",
      }),
    ]

    const toolEvents = collectCurrentSessionUsageEvents(lines).filter(
      (event) => event.kind === "tool"
    )

    expect(toolEvents.map(({ value, turnIndex }) => ({ value, turnIndex }))).toEqual([
      { value: "exec_command", turnIndex: 1 },
      { value: "apply_patch", turnIndex: 2 },
    ])
  })
})
