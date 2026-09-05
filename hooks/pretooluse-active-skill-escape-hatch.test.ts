import { describe, expect, test } from "bun:test"
import { hookOutputSchema } from "../src/schemas.ts"
import { hasActiveSkillForHookPayload } from "../src/skill-utils.ts"
import { evaluatePretooluseRequireTasks } from "./pretooluse-task-governance.ts"

// A skill drives its own ordered workflow. When a task-governance state gate fires mid-skill it
// blocks a step the skill itself prescribed, and the prescribed remedy (create/claim tasks) is
// unreachable without abandoning the skill. These cases lock in the stand-down.

const STALE_TIMESTAMP = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

function skillEvent(skill: string, timestamp: string, turnIndex: number) {
  return { kind: "skill", value: skill, turnIndex, timestamp }
}

/** Governance payload with an empty task queue — the state that normally denies. */
function emptyQueueInput(options: { skills?: string[]; timestamp?: string } = {}) {
  const { skills = [], timestamp = new Date().toISOString() } = options
  return {
    session_id: `escape-hatch-${Math.random().toString(36).slice(2)}`,
    cwd: process.cwd(),
    transcript_path: "/definitely/unavailable/transcript.jsonl",
    tool_name: "Bash",
    tool_input: { command: "echo probe" },
    _effectiveSettings: {
      skillRecencyMaxTurns: 30,
      skillRecencyMaxAgeMinutes: 20,
    },
    _currentSessionToolUsage: {
      toolNames: skills.map(() => "Skill"),
      skillInvocations: skills,
      events: skills.map((skill, index) => skillEvent(skill, timestamp, index + 1)),
    },
  }
}

describe("hasActiveSkillForHookPayload", () => {
  test("reports an active skill from current-session usage", async () => {
    expect(await hasActiveSkillForHookPayload(emptyQueueInput({ skills: ["commit"] }))).toBe(true)
  })

  test("reports no active skill when the session has invoked none", async () => {
    expect(await hasActiveSkillForHookPayload(emptyQueueInput())).toBe(false)
  })

  test("treats skill evidence outside the recency window as inactive", async () => {
    const input = emptyQueueInput({ skills: ["commit"], timestamp: STALE_TIMESTAMP })
    expect(await hasActiveSkillForHookPayload(input)).toBe(false)
  })

  test("fails closed on unusable input rather than disabling governance", async () => {
    expect(await hasActiveSkillForHookPayload({})).toBe(false)
  })
})

describe("task governance stands down while a skill is active", () => {
  test("denies the same empty queue when no skill is active (control)", async () => {
    // Without this control the stand-down cases below could pass vacuously — proving only that
    // the payload never reached a gate, not that an active skill is what cleared it.
    const output = hookOutputSchema.parse(await evaluatePretooluseRequireTasks(emptyQueueInput()))
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny")
  })

  test("does not deny an empty task queue when a skill is running", async () => {
    const result = await evaluatePretooluseRequireTasks(emptyQueueInput({ skills: ["commit"] }))
    const output = hookOutputSchema.parse(result)
    expect(output.hookSpecificOutput?.permissionDecision).not.toBe("deny")
  })

  test("still applies when several skills are active at once", async () => {
    const input = emptyQueueInput({ skills: ["commit", "push"] })
    const output = hookOutputSchema.parse(await evaluatePretooluseRequireTasks(input))
    expect(output.hookSpecificOutput?.permissionDecision).not.toBe("deny")
  })

  test("keeps enforcing once the skill's recency window has elapsed", async () => {
    // The stand-down is scoped to the skill's lifetime — it must not leak into ordinary work.
    const input = emptyQueueInput({ skills: ["commit"], timestamp: STALE_TIMESTAMP })
    expect(await hasActiveSkillForHookPayload(input)).toBe(false)
  })
})
