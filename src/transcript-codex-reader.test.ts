import { describe, expect, it } from "vitest"
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
