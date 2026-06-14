import { describe, expect, it } from "bun:test"
import { evaluateRequirementsGenerateGate } from "./pretooluse-requirements-generate-gate.ts"
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

function requirementsEditPayload(
  sessionLines: string[],
  filePath = "/repo/REQUIREMENTS.md"
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

describe("pretooluse-requirements-generate-gate", () => {
  it("ignores edits that do not target REQUIREMENTS.md", async () => {
    const result = await evaluateRequirementsGenerateGate(
      requirementsEditPayload([], "/repo/src/app.ts"),
      skillInstalled
    )
    expect(result).toEqual({})
  })

  it("ignores a REQUIREMENTS.md edit when /generate-requirements is not installed", async () => {
    const result = await evaluateRequirementsGenerateGate(requirementsEditPayload([]), skillMissing)
    expect(result).toEqual({})
  })

  it("allows a REQUIREMENTS.md edit when /generate-requirements was invoked recently", async () => {
    const result = await evaluateRequirementsGenerateGate(
      requirementsEditPayload([skillInvocationLine("generate-requirements")]),
      skillInstalled
    )
    expect(decisionOf(result)).toBe("allow")
  })

  it("blocks a REQUIREMENTS.md edit when /generate-requirements has not been invoked", async () => {
    const result = await evaluateRequirementsGenerateGate(
      requirementsEditPayload([skillInvocationLine("commit")]),
      skillInstalled
    )
    expect(decisionOf(result)).toBe("deny")
    expect(reasonOf(result)).toContain("generate-requirements")
  })

  it("blocks a REQUIREMENTS.md edit when the session has no skill invocations", async () => {
    const result = await evaluateRequirementsGenerateGate(
      requirementsEditPayload([]),
      skillInstalled
    )
    expect(decisionOf(result)).toBe("deny")
  })

  it("matches nested REQUIREMENTS.md files, not just the project root", async () => {
    const result = await evaluateRequirementsGenerateGate(
      requirementsEditPayload(
        [skillInvocationLine("commit")],
        "/repo/packages/app/REQUIREMENTS.md"
      ),
      skillInstalled
    )
    expect(decisionOf(result)).toBe("deny")
  })

  it("ignores a REQUIREMENTS.md edit when no transcript is available to scan", async () => {
    const payload = requirementsEditPayload([])
    payload.transcript_path = ""
    const result = await evaluateRequirementsGenerateGate(payload, skillInstalled)
    expect(result).toEqual({})
  })

  it("allows Write (not just Edit) to REQUIREMENTS.md after /generate-requirements was invoked", async () => {
    const payload = requirementsEditPayload([skillInvocationLine("generate-requirements")])
    payload.tool_name = "Write"
    payload.tool_input = { file_path: "/repo/REQUIREMENTS.md", content: "# requirements\n" }
    const result = await evaluateRequirementsGenerateGate(payload, skillInstalled)
    expect(decisionOf(result)).toBe("allow")
  })

  it("ignores edits to non-requirements files with requirements-like names", async () => {
    const result = await evaluateRequirementsGenerateGate(
      requirementsEditPayload([], "/repo/src/not-a-REQUIREMENTS.md.ts"),
      skillInstalled
    )
    expect(result).toEqual({})
  })
})
