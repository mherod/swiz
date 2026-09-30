import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { isInlineHookDef } from "../hook-types.ts"
import { bundledHookManifest } from "../manifest.ts"
import { keepSideEffectPostToolGroups, runsDuringSkills } from "./blockingStrategy.ts"

/**
 * PostToolUse hooks whose writes only serve their own advice (cooldowns,
 * scheduled steering). Skipping them during a skill just delays advice, so
 * they stay advisory. A hook that writes state another gate reads must set
 * `sideEffect: true` instead (#994).
 */
const ADVISORY_WRITE_HOOKS = new Set([
  "posttooluse-auto-steer",
  "posttooluse-push-autosteer-issue",
  "posttooluse-mid-session-prompt",
  "posttooluse-task-advisor",
  "posttooluse-task-count-context",
  "posttooluse-test-pairing",
])

const WRITE_PATTERN =
  /Bun\.write|writeFile|appendFile|\.record[A-Z]\w*\(|\.set[A-Z]?\w*\(|\.upsert|\.insert|\.mutate\(|Sentinel\(|markPushPrompted|scheduleAutoSteer|\.save\(/

const postToolHooks = bundledHookManifest
  .filter((group) => group.event === "postToolUse")
  .flatMap((group) => group.hooks)

async function writeBearingHookNames(): Promise<string[]> {
  const hooksDir = join(process.cwd(), "hooks")
  const files = (await readdir(hooksDir)).filter(
    (file) => file.startsWith("posttooluse-") && file.endsWith(".ts") && !file.endsWith(".test.ts")
  )
  const names: string[] = []
  for (const file of files) {
    const source = await Bun.file(join(hooksDir, file)).text()
    if (!WRITE_PATTERN.test(source)) continue
    for (const match of source.matchAll(/name: "(posttooluse-[\w-]+)"/g)) names.push(match[1]!)
  }
  return names
}

describe("stateful postToolUse hooks during skills", () => {
  test("every write-bearing hook is flagged sideEffect or explicitly advisory", async () => {
    const registered = new Map(
      postToolHooks.filter(isInlineHookDef).map((def) => [def.hook.name, def])
    )
    const writers = await writeBearingHookNames()
    // Control: the scan must see the known stateful hooks, or an empty result proves nothing.
    expect(writers.filter((name) => registered.has(name)).length).toBeGreaterThanOrEqual(7)
    const unclassified = writers.filter((name) => {
      const def = registered.get(name)
      if (!def) return false // not registered on postToolUse
      return !runsDuringSkills(def) && !ADVISORY_WRITE_HOOKS.has(name)
    })
    expect(unclassified).toEqual([])
  })

  test("TaskList sync survives the skill-recency filter", () => {
    const groups = bundledHookManifest.filter((group) => group.event === "postToolUse")
    const kept = keepSideEffectPostToolGroups(groups)
      .flatMap((group) => group.hooks)
      .filter(isInlineHookDef)
      .map((def) => def.hook.name)
    expect(kept).toContain("posttooluse-task-list-sync")
    expect(kept).toContain("posttooluse-session-edits")
    // Control: an advisory hook is still dropped.
    expect(kept).not.toContain("posttooluse-task-count-context")
  })
})
