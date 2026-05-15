import { describe, expect, test } from "bun:test"
import { type HookGroup, hookIdentifier } from "../manifest.ts"
import type { EffectiveSwizSettings } from "../settings.ts"
import { buildEffectiveTestSettings } from "../utils/test-utils.ts"
import { filterRequiredSettingsHooks } from "./filters.ts"

function makeEffective(overrides: Partial<EffectiveSwizSettings> = {}): EffectiveSwizSettings {
  return buildEffectiveTestSettings(overrides)
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
    expect(result[0]!.hooks.map((h) => hookIdentifier(h))).toEqual([
      "hook-keep.ts",
      "hook-also-keep.ts",
    ])
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
