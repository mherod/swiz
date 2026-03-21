import { describe, expect, test } from "bun:test"
import {
  groupMessages,
  parseSkillPayload,
  parseSkillToolCallName,
  skillExchangeMergeAt,
} from "./session-browser-utils.ts"

describe("parseSkillPayload", () => {
  test("parses canonical base directory line", () => {
    const text = "Base directory for this skill: /tmp/skills/foo\n\nbody here"
    expect(parseSkillPayload(text)).toEqual({
      baseDir: "/tmp/skills/foo",
      body: "body here",
      declaredSkill: null,
    })
  })

  test("parses SKILL CONTENT prefix and optional base dir line", () => {
    const text = [
      "SKILL CONTENT commit",
      "base dir /Users/me/.claude/skills/commit",
      "",
      "## Rules",
      "Do the thing.",
    ].join("\n")
    expect(parseSkillPayload(text)).toEqual({
      baseDir: "/Users/me/.claude/skills/commit",
      body: "## Rules\nDo the thing.",
      declaredSkill: "commit",
    })
  })
})

describe("parseSkillToolCallName", () => {
  test("rejects non-object JSON roots", () => {
    expect(parseSkillToolCallName("[1]")).toBeNull()
    expect(parseSkillToolCallName('"x"')).toBeNull()
  })

  test("rejects non-string skill field", () => {
    expect(parseSkillToolCallName(JSON.stringify({ skill: 1 }))).toBeNull()
    expect(parseSkillToolCallName(JSON.stringify({ skill: null }))).toBeNull()
  })
})

describe("skillExchangeMergeAt", () => {
  test("merges adjacent user skill payload with assistant Skill tool row (newest first)", () => {
    const user = {
      role: "user" as const,
      timestamp: "2026-03-21T13:36:08Z",
      text: "SKILL CONTENT commit\nbase dir /x\n\nbody",
    }
    const assistant = {
      role: "assistant" as const,
      timestamp: "2026-03-21T13:36:01Z",
      text: "",
      toolCalls: [{ name: "Skill", detail: JSON.stringify({ skill: "commit" }) }],
    }
    const sorted = [user, assistant]
    const grouped = groupMessages(sorted)
    const g0 = grouped[0]!
    const g1 = grouped[1]!
    expect(skillExchangeMergeAt(grouped, 0)).toEqual({
      user: g0,
      assistant: g1,
    })
  })

  test("does not merge when SKILL CONTENT name disagrees with tool payload", () => {
    const user = {
      role: "user" as const,
      timestamp: "2026-03-21T13:36:08Z",
      text: "SKILL CONTENT push\n\nbody",
    }
    const assistant = {
      role: "assistant" as const,
      timestamp: "2026-03-21T13:36:01Z",
      text: "",
      toolCalls: [{ name: "Skill", detail: JSON.stringify({ skill: "commit" }) }],
    }
    const sorted = [user, assistant]
    const grouped = groupMessages(sorted)
    expect(skillExchangeMergeAt(grouped, 0)).toBeNull()
  })

  test("does not merge when assistant has extra tools", () => {
    const user = {
      role: "user" as const,
      timestamp: "2026-03-21T13:36:08Z",
      text: "SKILL CONTENT commit\n\nbody",
    }
    const assistant = {
      role: "assistant" as const,
      timestamp: "2026-03-21T13:36:01Z",
      text: "",
      toolCalls: [
        { name: "Skill", detail: JSON.stringify({ skill: "commit" }) },
        { name: "Bash", detail: '{"command":"ls"}' },
      ],
    }
    const sorted = [user, assistant]
    const grouped = groupMessages(sorted)
    expect(skillExchangeMergeAt(grouped, 0)).toBeNull()
  })
})
