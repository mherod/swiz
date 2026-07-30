import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { HookLogEntry } from "../../hook-log.ts"
import type { MetricsRoutesContext } from "./metrics-routes.ts"
import {
  CooldownRegistry,
  createMetrics,
  GhQueryCache,
  GitStateCache,
  HookEligibilityCache,
  ManifestCache,
  ProjectSettingsCache,
  recordDispatch,
  TranscriptIndexCache,
} from "./runtime-cache.ts"

const requestedLogLimits: number[] = []
const hookLogEntries: HookLogEntry[] = [
  {
    ts: "2026-07-30T00:00:00.000Z",
    event: "preToolUse",
    hookEventName: "PreToolUse",
    hook: "first.ts",
    status: "ok",
    durationMs: 1,
    exitCode: 0,
    kind: "dispatch",
    hookCount: 1,
  },
  {
    ts: "2026-07-30T00:00:01.000Z",
    event: "preToolUse",
    hookEventName: "PreToolUse",
    hook: "second.ts",
    status: "ok",
    durationMs: 2,
    exitCode: 0,
    kind: "dispatch",
    hookCount: 1,
  },
]

void mock.module("../../hook-log.ts", () => ({
  readHookLogs: async (limit: number) => {
    requestedLogLimits.push(limit)
    return hookLogEntries.map((entry) => ({ ...entry }))
  },
}))

void mock.module("../../gh-rate-limit.ts", () => ({
  getGhRateLimitStats: async () => ({ remaining: 4321, limit: 5000 }),
}))

let routes: typeof import("./metrics-routes.ts")

beforeAll(async () => {
  routes = await import("./metrics-routes.ts")
})

beforeEach(() => {
  requestedLogLimits.length = 0
})

function createContext(): MetricsRoutesContext {
  const projectSettingsCache = new ProjectSettingsCache()
  return {
    ghCache: new GhQueryCache(),
    transcriptIndex: new TranscriptIndexCache(),
    eligibilityCache: new HookEligibilityCache(),
    cooldownRegistry: new CooldownRegistry(),
    gitStateCache: new GitStateCache(),
    projectSettingsCache,
    manifestCache: new ManifestCache(projectSettingsCache),
    snapshots: { size: 3 },
    projectMetrics: new Map(),
    globalMetrics: createMetrics(),
    watchers: { status: () => ({ active: 2 }) },
  }
}

describe("metrics routes", () => {
  test("returns global and per-project dispatch metrics", async () => {
    const ctx = createContext()
    const project = createMetrics()
    recordDispatch(ctx.globalMetrics, "stop", 20)
    recordDispatch(project, "preToolUse", 10)
    ctx.projectMetrics.set("/repo", project)

    const response = routes.handleMetricsRoute(new URL("http://daemon/metrics"), ctx)
    const body = await response.json()

    expect(body.totalDispatches).toBe(1)
    expect(body.projects["/repo"].totalDispatches).toBe(1)
    expect(body.caches.snapshots.size).toBe(3)
  })

  test("returns an isolated project view and an empty fallback for unknown projects", async () => {
    const ctx = createContext()
    const project = createMetrics()
    recordDispatch(project, "preToolUse", 12)
    ctx.projectMetrics.set("/repo", project)

    const known = await routes
      .handleMetricsRoute(new URL("http://daemon/metrics?project=/repo"), ctx)
      .json()
    const unknown = await routes
      .handleMetricsRoute(new URL("http://daemon/metrics?project=/missing"), ctx)
      .json()

    expect(known).toMatchObject({ project: "/repo", totalDispatches: 1 })
    expect(unknown).toMatchObject({ project: "/missing", totalDispatches: 0 })
  })

  test("reports cache and watcher status", async () => {
    const body = await routes.handleCacheStatus(createContext()).json()

    expect(body).toMatchObject({
      watchers: { active: 2 },
      snapshotCacheSize: 3,
      ghCacheSize: 0,
      eligibilityCacheSize: 0,
    })
  })

  test("clamps hook-log limits and reverses entries for newest-first output", async () => {
    const low = await routes.handleHookLogs(new URL("http://daemon/hook-logs?limit=0"))
    const high = await routes.handleHookLogs(new URL("http://daemon/hook-logs?limit=999"))
    const defaults = await routes.handleHookLogs(new URL("http://daemon/hook-logs"))

    expect(requestedLogLimits).toEqual([1, 500, 200])
    expect((await low.json()).entries.map((entry: HookLogEntry) => entry.hook)).toEqual([
      "second.ts",
      "first.ts",
    ])
    expect(high.status).toBe(200)
    expect(defaults.status).toBe(200)
  })

  test("returns GitHub rate-limit statistics", async () => {
    expect(await routes.handleGhRateLimit().then((response) => response.json())).toEqual({
      remaining: 4321,
      limit: 5000,
    })
  })
})
