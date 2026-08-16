import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { formatActiveSkillsContext } from "../src/active-skills-context.ts"
import { hookOutputSchema } from "../src/schemas.ts"
import { useTempDir } from "../src/utils/test-utils.ts"
import { evaluatePosttooluseActiveSkills } from "./posttooluse-active-skills.ts"
import { evaluatePretooluseActiveSkills } from "./pretooluse-active-skills.ts"

function usageEvent(skill: string, timestamp: string, turnIndex: number) {
  return { kind: "skill", value: skill, turnIndex, timestamp }
}

function activeSkillInput(skills: string[]) {
  const timestamp = new Date().toISOString()
  return {
    session_id: "active-skills-test",
    cwd: process.cwd(),
    transcript_path: "/definitely/unavailable/transcript.jsonl",
    tool_name: "Read",
    tool_input: { file_path: "README.md" },
    _effectiveSettings: {
      skillRecencyMaxTurns: 30,
      skillRecencyMaxAgeMinutes: 20,
    },
    _currentSessionToolUsage: {
      toolNames: skills.map(() => "Skill"),
      skillInvocations: skills,
      events: skills.map((skill, index) => usageEvent(skill, timestamp, index + 1)),
    },
  }
}

const tmp = useTempDir("swiz-active-skills-")

describe("active-skills tool hooks", () => {
  test("emits recently active skills before tool use", async () => {
    const result = await evaluatePretooluseActiveSkills(activeSkillInput(["commit", "push"]))
    const output = hookOutputSchema.parse(result)

    expect(output.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      additionalContext: "Currently active skills: /commit, /push.",
    })
  })

  test("refreshes recently active skills after tool use", async () => {
    const result = await evaluatePosttooluseActiveSkills(activeSkillInput(["commit", "push"]))
    const output = hookOutputSchema.parse(result)

    expect(output.hookSpecificOutput).toMatchObject({
      hookEventName: "PostToolUse",
      additionalContext: "Currently active skills: /commit, /push.",
    })
  })

  test("deduplicates skill evidence merged from current-session usage", async () => {
    const result = await evaluatePosttooluseActiveSkills(activeSkillInput(["commit", "commit"]))
    const output = hookOutputSchema.parse(result)

    expect(output.hookSpecificOutput?.additionalContext).toBe("Currently active skill: /commit.")
  })

  test("stays silent before and after tools when all skill evidence is stale", async () => {
    const input = activeSkillInput(["commit"])
    input._currentSessionToolUsage.events = [
      usageEvent("commit", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), 1),
    ]

    expect(await evaluatePretooluseActiveSkills(input)).toEqual({})
    expect(await evaluatePosttooluseActiveSkills(input)).toEqual({})
  })

  test("formats an already-filtered skill list with singular or plural heading", () => {
    expect(formatActiveSkillsContext(["commit"])).toBe("Currently active skill: /commit.")
    expect(formatActiveSkillsContext(["commit", "push"])).toBe(
      "Currently active skills: /commit, /push."
    )
  })

  test("includes a verified SKILL.md path when agent has not yet read or invoked the skill", async () => {
    const dir = await tmp.create()
    const skill = `active-path-${Date.now()}`
    const skillPath = join(dir, ".skills", skill, "SKILL.md")
    await mkdir(join(dir, ".skills", skill), { recursive: true })
    await writeFile(skillPath, `# ${skill}\n`)
    const timestamp = new Date().toISOString()
    const input = {
      session_id: "active-skills-test",
      cwd: dir,
      transcript_path: "/definitely/unavailable/transcript.jsonl",
      tool_name: "Read",
      tool_input: { file_path: "README.md" },
      _effectiveSettings: {
        skillRecencyMaxTurns: 30,
        skillRecencyMaxAgeMinutes: 20,
      },
      _currentSessionToolUsage: {
        toolNames: [],
        skillInvocations: [skill],
        events: [{ kind: "skill", value: skill, turnIndex: 1, timestamp, source: "user" }],
      },
    }

    const result = hookOutputSchema.parse(await evaluatePretooluseActiveSkills(input))
    expect(result.hookSpecificOutput?.additionalContext).toContain(skillPath)
  })

  test("omits verified SKILL.md path when agent has already invoked the skill", async () => {
    const dir = await tmp.create()
    const skill = `active-invoked-${Date.now()}`
    const skillPath = join(dir, ".skills", skill, "SKILL.md")
    await mkdir(join(dir, ".skills", skill), { recursive: true })
    await writeFile(skillPath, `# ${skill}\n`)
    const timestamp = new Date().toISOString()
    const input = {
      session_id: "active-skills-test",
      cwd: dir,
      transcript_path: "/definitely/unavailable/transcript.jsonl",
      tool_name: "Read",
      tool_input: { file_path: "README.md" },
      _effectiveSettings: {
        skillRecencyMaxTurns: 30,
        skillRecencyMaxAgeMinutes: 20,
      },
      _currentSessionToolUsage: {
        toolNames: ["Skill"],
        skillInvocations: [skill],
        events: [{ kind: "skill", value: skill, turnIndex: 1, timestamp, source: "agent" }],
      },
    }

    const result = hookOutputSchema.parse(await evaluatePretooluseActiveSkills(input))
    expect(result.hookSpecificOutput?.additionalContext).not.toContain(skillPath)
    expect(result.hookSpecificOutput?.additionalContext).toContain(`/${skill}`)
  })

  test("omits verified SKILL.md path when agent has already directly read SKILL.md", async () => {
    const dir = await tmp.create()
    const skill = `active-read-${Date.now()}`
    const skillPath = join(dir, ".skills", skill, "SKILL.md")
    await mkdir(join(dir, ".skills", skill), { recursive: true })
    await writeFile(skillPath, `# ${skill}\n`)
    const timestamp = new Date().toISOString()
    const input = {
      session_id: "active-skills-test",
      cwd: dir,
      transcript_path: "/definitely/unavailable/transcript.jsonl",
      tool_name: "Read",
      tool_input: { file_path: "README.md" },
      _effectiveSettings: {
        skillRecencyMaxTurns: 30,
        skillRecencyMaxAgeMinutes: 20,
      },
      _currentSessionToolUsage: {
        toolNames: ["Read"],
        skillInvocations: [skill],
        readFiles: [skillPath],
        events: [
          { kind: "skill", value: skill, turnIndex: 1, timestamp, source: "user" },
          { kind: "read-file", value: skillPath, turnIndex: 1, timestamp, source: "agent" },
        ],
      },
    }

    const result = hookOutputSchema.parse(await evaluatePretooluseActiveSkills(input))
    expect(result.hookSpecificOutput?.additionalContext).not.toContain(skillPath)
    expect(result.hookSpecificOutput?.additionalContext).toContain(`/${skill}`)
  })
})
