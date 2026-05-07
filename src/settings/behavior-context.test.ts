import { describe, expect, test } from "bun:test"
import { BEHAVIOR_STEERING_SETTING_GROUPS, buildBehaviorSteeringContext } from "./behavior-context"
import { DEFAULT_SETTINGS } from "./persistence"
import type { EffectiveSwizSettings } from "./types"

function makeEffective(overrides: Partial<EffectiveSwizSettings> = {}): EffectiveSwizSettings {
  const { disabledHooks: _disabledHooks, sessions: _sessions, ...base } = DEFAULT_SETTINGS
  return {
    ...base,
    source: "global",
    ...overrides,
  }
}

describe("buildBehaviorSteeringContext", () => {
  test("summarizes behavior-affecting settings by concern", () => {
    const context = buildBehaviorSteeringContext(makeEffective(), { defaultBranch: "main" })

    expect(context).toContain("Swiz behavior settings:")
    expect(context).toContain("Workflow policy:")
    expect(context).toContain("Stop gates expect")
    expect(context).toContain("Task governance: strict audit strictness")
    expect(context).toContain("Safeguards:")
    expect(context).toContain("Memory and check-ins:")
  })

  test("surfaces trunk-mode as workflow steering", () => {
    const context = buildBehaviorSteeringContext(
      makeEffective({ collaborationMode: "solo", trunkMode: true }),
      { defaultBranch: "main" }
    )

    expect(context).toContain("trunk mode keeps work on main with direct pushes when ready")
  })

  test("calls out conflicting branch workflow settings", () => {
    const context = buildBehaviorSteeringContext(
      makeEffective({ strictNoDirectMain: true, trunkMode: true }),
      { defaultBranch: "main" }
    )

    expect(context).toContain("trunk mode conflicts with strict no-direct-main")
    expect(context).toContain("resolve that before pushing")
  })

  test("can include automation settings when explicitly requested", () => {
    const context = buildBehaviorSteeringContext(makeEffective({ autoSteer: true, speak: true }), {
      includeAutomation: true,
    })

    expect(context).toContain("Automation:")
    expect(context).toContain("terminal auto-steer is on")
    expect(context).toContain("spoken narration is on")
  })

  test("uses project-local memory thresholds when provided", () => {
    const context = buildBehaviorSteeringContext(makeEffective(), {
      memoryLineThreshold: 700,
      memoryWordThreshold: 3500,
    })

    expect(context).toContain("compact memory around 700 lines or 3500 words")
  })
})

describe("BEHAVIOR_STEERING_SETTING_GROUPS", () => {
  test("keeps high-value blocking concerns visible", () => {
    expect(BEHAVIOR_STEERING_SETTING_GROUPS.workflow).toContain("trunkMode")
    expect(BEHAVIOR_STEERING_SETTING_GROUPS.stopGates).toContain("githubCiGate")
    expect(BEHAVIOR_STEERING_SETTING_GROUPS.taskGovernance).toContain("auditStrictness")
    expect(BEHAVIOR_STEERING_SETTING_GROUPS.safeguards).toContain("dirtyWorktreeThreshold")
    expect(BEHAVIOR_STEERING_SETTING_GROUPS.memoryAndCheckins).toContain("memoryUpdateReminder")
  })
})
