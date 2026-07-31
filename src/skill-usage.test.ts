import { describe, expect, it } from "bun:test"
import {
  extractSkillInvocationPreamble,
  extractSkillNameFromCapturedSkillDetail,
  extractSkillNameFromSkillMdPathText,
  extractSkillNameFromSlashPrompt,
  extractSkillNamesFromCodexExecCode,
  extractSkillNamesFromShellSkillReadCommand,
  extractSkillNamesFromShellSkillUsageCommand,
  extractSkillNamesFromUserText,
  formatSkillToolInputDetail,
} from "./skill-usage.ts"

describe("skill usage detection", () => {
  it("extracts skill names from SKILL.md paths", () => {
    expect(extractSkillNameFromSkillMdPathText("/Users/me/.codex/skills/commit/SKILL.md")).toBe(
      "commit"
    )
    expect(extractSkillNameFromSkillMdPathText("~/.../push/SKILL.md")).toBeNull()
  })

  it("treats read-only shell SKILL.md access as a skill invocation", () => {
    expect(
      extractSkillNamesFromShellSkillReadCommand("sed -n '1,200p' ~/.agents/skills/push/SKILL.md")
    ).toEqual(["push"])
    expect(extractSkillNamesFromShellSkillReadCommand("cat ~/.../commit/SKILL.md")).toEqual([
      "commit",
    ])
    expect(
      extractSkillNamesFromShellSkillReadCommand(
        "wc -l ~/.codex/skills/push/SKILL.md; sed -n '1,200p' ~/.codex/skills/push/SKILL.md"
      )
    ).toEqual(["push"])
  })

  it("treats swiz skill output as a skill invocation", () => {
    expect(
      extractSkillNamesFromShellSkillUsageCommand("swiz skill commit --no-front-matter")
    ).toEqual(["commit"])
    expect(
      extractSkillNamesFromShellSkillUsageCommand("bun run index.ts skill --raw push")
    ).toEqual(["push"])
    expect(
      extractSkillNamesFromShellSkillUsageCommand(
        "swiz skill --sync --from claude --to codex --overwrite"
      )
    ).toEqual([])
  })

  it("extracts skill reads only from executed Codex wrapper commands", () => {
    expect(
      extractSkillNamesFromCodexExecCode(
        'const r = await tools.exec_command({cmd:"cat ~/.codex/skills/commit/SKILL.md"}); text(r.output);'
      )
    ).toEqual(["commit"])
    expect(
      extractSkillNamesFromCodexExecCode(
        'const note = "cat ~/.codex/skills/commit/SKILL.md"; text(note);'
      )
    ).toEqual([])
  })

  it("does not treat shell writes to SKILL.md files as skill invocations", () => {
    expect(
      extractSkillNamesFromShellSkillReadCommand(
        "echo '# Modified' > /Users/me/.codex/skills/commit/SKILL.md"
      )
    ).toEqual([])
  })

  it("extracts skills from user transcript skill markers", () => {
    expect(
      extractSkillNamesFromUserText(
        "<command-name>commit</command-name>\nBase directory for this skill: /Users/me/.claude/skills/push"
      )
    ).toEqual(["push", "commit"])
    expect(extractSkillNameFromSlashPrompt("$refine-issue 123")).toBe("refine-issue")
  })

  it("extracts explicitly attached Codex skills from user text", () => {
    expect(
      extractSkillNamesFromUserText(
        "Use [$debug-iteratively](/Users/me/.codex/skills/debug-iteratively/SKILL.md)"
      )
    ).toEqual(["debug-iteratively"])
    expect(
      extractSkillNamesFromUserText(
        "<skill>\n<name>forensic-code-analysis</name>\n<path>/Users/me/.codex/skills/forensic-code-analysis/SKILL.md</path>\n</skill>"
      )
    ).toEqual(["forensic-code-analysis"])
  })

  it("does not treat an ordinary SKILL.md link as an explicit invocation", () => {
    expect(
      extractSkillNamesFromUserText(
        "See [the debugging skill](/Users/me/.codex/skills/debug-iteratively/SKILL.md)"
      )
    ).toEqual([])
    expect(
      extractSkillNamesFromUserText(
        "[$debug-iteratively](/Users/me/.codex/skills/forensic-code-analysis/SKILL.md)"
      )
    ).toEqual([])
  })

  it("extracts skill preambles for display stripping", () => {
    expect(
      extractSkillInvocationPreamble("Base directory for this skill: C:\\Users\\me\\skills\\commit")
    ).toEqual({ name: "commit", rest: "" })
    expect(extractSkillInvocationPreamble("note\nSKILL CONTENT push\nbody")).toEqual({
      name: "push",
      rest: "note",
    })
  })

  it("formats and recovers daemon skill call details", () => {
    expect(formatSkillToolInputDetail({ skill: "commit", args: "--amend" })).toBe("commit --amend")
    expect(extractSkillNameFromCapturedSkillDetail("commit --amend")).toBe("commit")
  })
})
