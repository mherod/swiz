import { describe, expect, test } from "bun:test"
import type { HookGroup } from "../manifest.ts"
import type { EffectiveSwizSettings } from "../settings.ts"
import { filterRequiredSettingsHooks } from "./filters.ts"

/** Minimal effective settings for testing — all gates enabled by default. */
function makeEffective(overrides: Partial<EffectiveSwizSettings> = {}): EffectiveSwizSettings {
  return {
    autoContinue: true,
    critiquesEnabled: true,
    ambitionMode: "standard",
    collaborationMode: "auto",
    narratorVoice: "",
    narratorSpeed: 0,
    prAgeGateMinutes: 10,
    prMergeMode: true,
    pushCooldownMinutes: 0,
    pushGate: false,
    sandboxedEdits: true,
    speak: false,
    autoSteer: false,
    updateMemoryFooter: false,
    gitStatusGate: true,
    nonDefaultBranchGate: true,
    ignoreCi: false,
    githubCiGate: true,
    changesRequestedGate: true,
    personalRepoIssuesGate: true,
    issueCloseGate: false,
    memoryUpdateReminder: false,
    qualityChecksGate: true,
    skipSecretScan: false,
    strictNoDirectMain: false,
    trunkMode: false,
    auditStrictness: "strict",
    taskDurationWarningMinutes: 10,
    memoryLineThreshold: 1400,
    memoryWordThreshold: 5000,
    largeFileSizeKb: 500,
    largeFileSizeBlockKb: 5120,
    dirtyWorktreeThreshold: 15,
    statusLineSegments: [],
    source: "global",
    ...overrides,
  }
}

function makeGroup(hooks: HookGroup["hooks"], event = "stop"): HookGroup {
  return { event, hooks }
}

describe("filterRequiredSettingsHooks", () => {
  test("hooks with no requiredSettings pass through unchanged", () => {
    const groups: HookGroup[] = [makeGroup([{ file: "hook-a.ts" }, { file: "hook-b.ts" }])]
    const result = filterRequiredSettingsHooks(groups, makeEffective())
    expect(result).toHaveLength(1)
    expect(result[0]!.hooks).toHaveLength(2)
  })

  test("hooks with all-truthy required settings pass through", () => {
    const groups: HookGroup[] = [
      makeGroup([
        { file: "hook-a.ts", requiredSettings: ["qualityChecksGate"] },
        { file: "hook-b.ts", requiredSettings: ["githubCiGate"] },
      ]),
    ]
    const result = filterRequiredSettingsHooks(groups, makeEffective())
    expect(result).toHaveLength(1)
    expect(result[0]!.hooks).toHaveLength(2)
  })

  test("hooks with any falsy required setting are filtered out", () => {
    const groups: HookGroup[] = [
      makeGroup([{ file: "hook-a.ts", requiredSettings: ["qualityChecksGate"] }]),
    ]
    const result = filterRequiredSettingsHooks(groups, makeEffective({ qualityChecksGate: false }))
    expect(result).toHaveLength(0)
  })

  test("empty groups are removed after filtering", () => {
    const groups: HookGroup[] = [
      makeGroup([{ file: "hook-a.ts", requiredSettings: ["issueCloseGate"] }]),
    ]
    // issueCloseGate defaults to false
    const result = filterRequiredSettingsHooks(groups, makeEffective())
    expect(result).toHaveLength(0)
  })

  test("mixed groups — some hooks filtered, some kept", () => {
    const groups: HookGroup[] = [
      makeGroup([
        { file: "hook-keep.ts" },
        { file: "hook-gate.ts", requiredSettings: ["qualityChecksGate"] },
        { file: "hook-also-keep.ts", requiredSettings: ["githubCiGate"] },
      ]),
    ]
    const result = filterRequiredSettingsHooks(groups, makeEffective({ qualityChecksGate: false }))
    expect(result).toHaveLength(1)
    expect(result[0]!.hooks).toHaveLength(2)
    expect(result[0]!.hooks.map((h) => h.file)).toEqual(["hook-keep.ts", "hook-also-keep.ts"])
  })

  test("hooks with multiple required settings — all must be truthy", () => {
    const groups: HookGroup[] = [
      makeGroup([{ file: "hook-a.ts", requiredSettings: ["qualityChecksGate", "githubCiGate"] }]),
    ]
    // Both truthy
    const result1 = filterRequiredSettingsHooks(groups, makeEffective())
    expect(result1).toHaveLength(1)

    // One falsy
    const result2 = filterRequiredSettingsHooks(groups, makeEffective({ githubCiGate: false }))
    expect(result2).toHaveLength(0)
  })

  test("empty requiredSettings array passes through", () => {
    const groups: HookGroup[] = [makeGroup([{ file: "hook-a.ts", requiredSettings: [] }])]
    const result = filterRequiredSettingsHooks(groups, makeEffective())
    expect(result).toHaveLength(1)
  })

  test("preserves original group when no hooks are filtered", () => {
    const group = makeGroup([{ file: "hook-a.ts", requiredSettings: ["qualityChecksGate"] }])
    const groups = [group]
    const result = filterRequiredSettingsHooks(groups, makeEffective())
    expect(result[0]).toBe(group) // Same reference — no unnecessary spread
  })
})
