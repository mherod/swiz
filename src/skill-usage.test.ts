import { describe, expect, it } from "bun:test"
import {
  extractSkillInvocationPreamble,
  extractSkillNameFromCapturedSkillDetail,
  extractSkillNameFromSkillMdPathText,
  extractSkillNameFromSlashPrompt,
  extractSkillNamesFromShellSkillReadCommand,
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
