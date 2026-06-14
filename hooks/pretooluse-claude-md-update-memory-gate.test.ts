import { describe, expect, it } from "bun:test"
import { evaluateClaudeMdUpdateMemoryGate } from "./pretooluse-claude-md-update-memory-gate.ts"
import { summaryFromLines } from "./test-helpers/transcript-summary-fixture.ts"

// In-process tests only — no hook subprocess spawns (see CLAUDE.md performance rule).
// Skill existence is injected (so the test never mutates process.cwd(), which races
// under concurrent multi-file runs); recency is exercised through the real
// transcript-summary path by injecting `_transcriptSummary.sessionLines`.

const skillInstalled = () => true
const skillMissing = () => false

function assistantLine(content: unknown[], timestampMs = Date.now() - 1000): string {
  return JSON.stringify({
    timestamp: new Date(timestampMs).toISOString(),
    type: "assistant",
    message: { content },
  })
}

const skillInvocationLine = (skill: string): string =>
  assistantLine([{ type: "tool_use", name: "Skill", input: { skill } }])

const decisionOf = (result: Record<string, any>): string | undefined =>
  result?.hookSpecificOutput?.permissionDecision

const reasonOf = (result: Record<string, any>): string =>
  String(result?.hookSpecificOutput?.permissionDecisionReason ?? "")

function claudeMdEditPayload(
  sessionLines: string[],
  filePath = "/repo/CLAUDE.md"
): Record<string, any> {
  return {
    tool_name: "Edit",
    tool_input: { file_path: filePath },
    transcript_path: "fake-transcript.json",
    cwd: "/repo",
    _agent: "claude",
    _transcriptSummary: summaryFromLines(sessionLines),
  }
}

describe("pretooluse-claude-md-update-memory-gate", () => {
  it("ignores edits that do not target a CLAUDE.md file", async () => {
    const result = await evaluateClaudeMdUpdateMemoryGate(
      claudeMdEditPayload([], "/repo/src/app.ts"),
      skillInstalled
    )
    expect(result).toEqual({})
  })

  it("ignores a CLAUDE.md edit when the /update-memory skill is not installed", async () => {
    const result = await evaluateClaudeMdUpdateMemoryGate(claudeMdEditPayload([]), skillMissing)
    expect(result).toEqual({})
  })

  it("allows a CLAUDE.md edit when /update-memory was invoked recently", async () => {
    const result = await evaluateClaudeMdUpdateMemoryGate(
      claudeMdEditPayload([skillInvocationLine("update-memory")]),
      skillInstalled
    )
    expect(decisionOf(result)).toBe("allow")
  })

  it("blocks a CLAUDE.md edit when /update-memory has not been invoked", async () => {
    const result = await evaluateClaudeMdUpdateMemoryGate(
      claudeMdEditPayload([skillInvocationLine("commit")]),
      skillInstalled
    )
    expect(decisionOf(result)).toBe("deny")
    expect(reasonOf(result)).toContain("update-memory")
  })

  it("blocks a CLAUDE.md edit when the session has no skill invocations", async () => {
    const result = await evaluateClaudeMdUpdateMemoryGate(claudeMdEditPayload([]), skillInstalled)
    expect(decisionOf(result)).toBe("deny")
  })

  it("matches nested CLAUDE.md files, not just the project root", async () => {
    const result = await evaluateClaudeMdUpdateMemoryGate(
      claudeMdEditPayload([skillInvocationLine("commit")], "/repo/packages/app/CLAUDE.md"),
      skillInstalled
    )
    expect(decisionOf(result)).toBe("deny")
  })

  it("ignores a CLAUDE.md edit when no transcript is available to scan", async () => {
    const payload = claudeMdEditPayload([])
    payload.transcript_path = ""
    const result = await evaluateClaudeMdUpdateMemoryGate(payload, skillInstalled)
    expect(result).toEqual({})
  })

  it("allows Write (not just Edit) to CLAUDE.md after /update-memory was invoked", async () => {
    const payload = claudeMdEditPayload([skillInvocationLine("update-memory")])
    payload.tool_name = "Write"
    payload.tool_input = { file_path: "/repo/CLAUDE.md", content: "# memory\n" }
    const result = await evaluateClaudeMdUpdateMemoryGate(payload, skillInstalled)
    expect(decisionOf(result)).toBe("allow")
  })

  it("blocks GEMINI.md edit without /update-memory", async () => {
    const result = await evaluateClaudeMdUpdateMemoryGate(
      claudeMdEditPayload([skillInvocationLine("commit")], "/repo/GEMINI.md"),
      skillInstalled
    )
    expect(decisionOf(result)).toBe("deny")
  })

  it("blocks AGENTS.md edit without /update-memory", async () => {
    const result = await evaluateClaudeMdUpdateMemoryGate(
      claudeMdEditPayload([skillInvocationLine("commit")], "/repo/AGENTS.md"),
      skillInstalled
    )
    expect(decisionOf(result)).toBe("deny")
  })

  it("blocks .cursorrules edit without /update-memory", async () => {
    const result = await evaluateClaudeMdUpdateMemoryGate(
      claudeMdEditPayload([skillInvocationLine("commit")], "/repo/.cursorrules"),
      skillInstalled
    )
    expect(decisionOf(result)).toBe("deny")
  })

  it("allows GEMINI.md edit after /update-memory was invoked", async () => {
    const result = await evaluateClaudeMdUpdateMemoryGate(
      claudeMdEditPayload([skillInvocationLine("update-memory")], "/repo/GEMINI.md"),
      skillInstalled
    )
    expect(decisionOf(result)).toBe("allow")
  })

  it("ignores edits to non-memory files even when they contain memory-like names", async () => {
    const result = await evaluateClaudeMdUpdateMemoryGate(
      claudeMdEditPayload([], "/repo/src/not-a-CLAUDE.md.ts"),
      skillInstalled
    )
    expect(result).toEqual({})
  })
})
