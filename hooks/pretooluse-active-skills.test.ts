import { describe, expect, test } from "bun:test"
import { formatActiveSkillsContext } from "../src/active-skills-context.ts"
import { hookOutputSchema } from "../src/schemas.ts"
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
    tool_name: "Read",
    tool_input: { file_path: "README.md" },
    _currentSessionToolUsage: {
      toolNames: skills.map(() => "Skill"),
      skillInvocations: skills,
      events: skills.map((skill, index) => usageEvent(skill, timestamp, index + 1)),
    },
  }
}

describe("active-skills tool hooks", () => {
  test("emits recently active skills before tool use", async () => {
    const result = await evaluatePretooluseActiveSkills(activeSkillInput(["commit", "push"]))
    const output = hookOutputSchema.parse(result)

    expect(output.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      additionalContext: expect.stringMatching(
        /^Recently (active|ongoing|live|engaged|open|current|running) skills \(last \d+ turns and last \d+ minutes\): \/commit, \/push\.$/
      ),
    })
  })

  test("refreshes recently active skills after tool use", async () => {
    const result = await evaluatePosttooluseActiveSkills(activeSkillInput(["commit", "push"]))
    const output = hookOutputSchema.parse(result)

    expect(output.hookSpecificOutput).toMatchObject({
      hookEventName: "PostToolUse",
      additionalContext: expect.stringMatching(/: \/commit, \/push\.$/),
    })
  })

  test("deduplicates skill evidence merged from current-session usage", async () => {
    const result = await evaluatePosttooluseActiveSkills(activeSkillInput(["commit", "commit"]))
    const output = hookOutputSchema.parse(result)

    expect(output.hookSpecificOutput?.additionalContext).toMatch(/: \/commit\.$/)
  })

  test("stays silent before and after tools when all skill evidence is stale", async () => {
    const input = activeSkillInput(["commit"])
    input._currentSessionToolUsage.events = [
      usageEvent("commit", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), 1),
    ]

    expect(await evaluatePretooluseActiveSkills(input)).toEqual({})
    expect(await evaluatePosttooluseActiveSkills(input)).toEqual({})
  })

  test("formats an already-filtered skill list without adding policy", () => {
    expect(formatActiveSkillsContext(["commit", "push"], "configured window")).toBe(
      "Recently active skills (configured window): /commit, /push."
    )
  })
})
