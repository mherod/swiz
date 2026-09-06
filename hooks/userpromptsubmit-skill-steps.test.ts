import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { evaluateUserpromptsubmitSkillSteps } from "./userpromptsubmit-skill-steps.ts"

const HOOKS_DIR = import.meta.dir

function qualifyingInput(settings?: Record<string, unknown>) {
  return {
    session_id: "session-skill-steps",
    cwd: HOOKS_DIR,
    // A real skill name, so only the gate can stop this input from creating tasks.
    prompt: "/morning-standup",
    ...(settings ? { _effectiveSettings: settings } : {}),
  }
}

describe("userpromptsubmit-skill-steps", () => {
  test("creates no tasks when actionPlanMerge is disabled", async () => {
    // #872: this hook skipped the opt-in gate its sibling honoured, so typing `/some-skill`
    // scraped that SKILL.md's step bullets into tasks — 16 in one session, each blocking the
    // stop gate with a subject byte-identical to its description.
    expect(
      await evaluateUserpromptsubmitSkillSteps(qualifyingInput({ actionPlanMerge: false }))
    ).toEqual({})
  })

  test("fails closed when effective settings are absent", async () => {
    // The setting is documented as opt-in, so an unknown value must not enable creation.
    expect(await evaluateUserpromptsubmitSkillSteps(qualifyingInput())).toEqual({})
  })

  test("every skill-steps task creator gates on actionPlanMerge", async () => {
    // The behavioural assertions above cannot prove the positive path in-process: SKILL_DIRS
    // is resolved from HOME at module load, so exercising it would write tasks to the real
    // task store. This structural invariant is the control instead — it is what actually
    // catches this bug class, a new caller of the shared helper forgetting the gate.
    const entries = await readdir(HOOKS_DIR)
    const callers: string[] = []
    for (const entry of entries) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue
      const source = await Bun.file(join(HOOKS_DIR, entry)).text()
      if (source.includes("createTasksFromSkillSteps")) callers.push(entry)
    }

    // Both known callers must be present, so the sweep cannot pass by finding nothing.
    expect(callers).toContain("userpromptsubmit-skill-steps.ts")
    expect(callers).toContain("posttooluse-skill-steps.ts")

    // Match the guard expression, not the identifier: an earlier draft of this test passed
    // against a hook whose gate had been deleted, because the explanatory comment above it
    // still contained the word "actionPlanMerge".
    const GATE_RE = /if\s*\(\s*!\s*settings\??\.?\s*\??\.actionPlanMerge\s*\)\s*return/
    for (const caller of callers) {
      const source = await Bun.file(join(HOOKS_DIR, caller)).text()
      expect(GATE_RE.test(source), `${caller} must gate task creation on actionPlanMerge`).toBe(
        true
      )
    }
  })
})
