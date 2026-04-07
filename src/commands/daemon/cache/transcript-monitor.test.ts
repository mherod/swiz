import { beforeEach, describe, expect, test } from "bun:test"
import type { HookGroup } from "../../../hook-types.ts"
import { CooldownRegistry } from "./cooldown-registry.ts"
import { TranscriptMonitor } from "./transcript-monitor.ts"

type MonitorWithCooldown = {
  isEventOnCooldown: (groups: HookGroup[], event: string, cwd: string) => Promise<boolean>
}

describe("TranscriptMonitor isEventOnCooldown", () => {
  let registry: CooldownRegistry

  beforeEach(() => {
    registry = new CooldownRegistry()
  })

  test("sync CooldownRegistry: second check is within cooldown", async () => {
    const groups: HookGroup[] = [
      {
        event: "postToolUse",
        hooks: [{ file: "hooks/a.ts", cooldownSeconds: 3600 }],
      },
    ]
    const monitor = new TranscriptMonitor({
      manifestCache: { get: async () => [] },
      cooldownRegistry: registry,
      projectSettingsCache: { get: async () => ({ settings: null }) },
    })
    const check = (monitor as unknown as MonitorWithCooldown).isEventOnCooldown.bind(monitor)

    expect(await check(groups, "postToolUse", "/proj")).toBe(false)
    expect(await check(groups, "postToolUse", "/proj")).toBe(true)
  })

  test("async checkAndMark result is awaited", async () => {
    let call = 0
    const groups: HookGroup[] = [
      {
        event: "postToolUse",
        hooks: [{ file: "hooks/b.ts", cooldownSeconds: 60 }],
      },
    ]
    const monitor = new TranscriptMonitor({
      manifestCache: { get: async () => [] },
      cooldownRegistry: {
        checkAndMark: async () => {
          call += 1
          return call >= 2
        },
      },
      projectSettingsCache: { get: async () => ({ settings: null }) },
    })
    const check = (monitor as unknown as MonitorWithCooldown).isEventOnCooldown.bind(monitor)

    expect(await check(groups, "postToolUse", "/p")).toBe(false)
    expect(await check(groups, "postToolUse", "/p")).toBe(true)
  })
})

describe("TranscriptMonitor getDispatchConcurrencyMetrics", () => {
  test("exposes concurrency gate metrics", () => {
    const monitor = new TranscriptMonitor({
      manifestCache: { get: async () => [] },
      cooldownRegistry: new CooldownRegistry(),
      projectSettingsCache: { get: async () => ({ settings: null }) },
    })

    const metrics = monitor.getDispatchConcurrencyMetrics()
    expect(metrics).toEqual({
      active: 0,
      queued: 0,
      maxConcurrent: 0,
    })
  })
})
