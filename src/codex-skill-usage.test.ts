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

function codexUserLine(text: string): string {
  return JSON.stringify({
    timestamp: "2026-07-31T18:42:46.465Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
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

  it("detects skills explicitly attached in a Codex user prompt", () => {
    const line = codexUserLine(
      "Investigate with [$debug-iteratively](/Users/me/.codex/skills/debug-iteratively/SKILL.md) and [$forensic-code-analysis](/Users/me/.codex/skills/forensic-code-analysis/SKILL.md)"
    )

    expect(detectedSkills([line])).toEqual({
      summary: ["debug-iteratively", "forensic-code-analysis"],
      events: ["debug-iteratively", "forensic-code-analysis"],
    })
  })

  it("detects the persisted Codex skill expansion record", () => {
    const line = codexUserLine(
      "<skill>\n<name>debug-iteratively</name>\n<path>/Users/me/.codex/skills/debug-iteratively/SKILL.md</path>\n---\nname: debug-iteratively\n</skill>"
    )

    expect(detectedSkills([line])).toEqual({
      summary: ["debug-iteratively"],
      events: ["debug-iteratively"],
    })
  })
})
