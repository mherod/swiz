import { describe, expect, it } from "bun:test"
import {
  collectCurrentSessionUsageEvents,
  computeSummaryFromSessionLines,
} from "./transcript-summary.ts"

function codexExecLine(input: string, name = "exec"): string {
  return JSON.stringify({
    timestamp: "2026-07-31T15:20:54.377Z",
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name,
      input,
    },
  })
}

function detectedSkills(lines: string[]): { summary: string[]; events: string[] } {
  return {
    summary: computeSummaryFromSessionLines(lines).skillInvocations,
    events: collectCurrentSessionUsageEvents(lines)
      .filter((event) => event.kind === "skill")
      .map((event) => event.value),
  }
}

describe("Codex skill usage detection", () => {
  it("detects a SKILL.md read nested in a Codex exec custom tool call", () => {
    const line = codexExecLine(
      'const r = await tools.exec_command({cmd:"cat /Users/me/.codex/skills/commit/SKILL.md\\nrg -n commit README.md",workdir:"/repo"}); text(r.output);'
    )

    expect(detectedSkills([line])).toEqual({
      summary: ["commit"],
      events: ["commit"],
    })
  })

  it("detects swiz skill output nested in a namespaced Codex exec call", () => {
    const line = codexExecLine(
      'const r = await tools.exec_command({cmd:"swiz skill push --no-front-matter",workdir:"/repo"}); text(r.output);',
      "functions.exec"
    )

    expect(detectedSkills([line])).toEqual({
      summary: ["push"],
      events: ["push"],
    })
  })

  it("does not count SKILL.md text that is not executed as a read", () => {
    const line = codexExecLine(
      'const note = "cat /Users/me/.codex/skills/commit/SKILL.md"; text(note);'
    )

    expect(detectedSkills([line])).toEqual({ summary: [], events: [] })
  })
})
