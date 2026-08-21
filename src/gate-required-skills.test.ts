import { describe, expect, test } from "bun:test"
import { GATE_REQUIRED_SKILLS, listGateRequiredSkills } from "./gate-required-skills.ts"

describe("gate-required skill registry", () => {
  test("enumerates the complete fail-open enforcement set", () => {
    expect(listGateRequiredSkills().map((entry) => entry.name)).toEqual([
      "commit",
      "push",
      "triage-issues",
      "refine-issue",
      "work-on-issue",
      "pr-open",
      "pr-qa-and-merge",
      "pr-comments-address",
      "update-memory",
      "generate-requirements",
      "apply-rsc",
      "convert-to-kotlin",
      "collaborate-with-another-agent",
      "end-of-day",
      "farm-out-issues",
      "continue-with-tasks",
      "reflect-on-session-mistakes",
    ])
  })

  test("keeps skill names unique and attributes every entry to an owning hook", () => {
    const entries = listGateRequiredSkills()
    expect(new Set(entries.map((entry) => entry.name)).size).toBe(entries.length)
    for (const entry of entries) {
      expect(entry.hooks.length).toBeGreaterThan(0)
      expect(new Set(entry.hooks).size).toBe(entry.hooks.length)
    }
  })

  test("shares multi-gate requirements without repeating their skill names", () => {
    expect(GATE_REQUIRED_SKILLS.prCommentsAddress.hooks).toEqual([
      "pretooluse-skill-invocation-gate",
      "pretooluse-pr-comment-read-gate",
    ])
    expect(GATE_REQUIRED_SKILLS.updateMemory.hooks).toEqual([
      "pretooluse-claude-md-update-memory-gate",
      "pretooluse-update-memory-enforcement",
    ])
  })
})
