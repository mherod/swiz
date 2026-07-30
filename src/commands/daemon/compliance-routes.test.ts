import { afterEach, describe, expect, test } from "bun:test"
import { TaskStateCache } from "../../tasks/task-state-cache.ts"
import type { WarmStatusLineSnapshot } from "../status-line.ts"
import { CappedMap } from "./cache/capped-map.ts"
import {
  type ComplianceRoutesContext,
  handleComplianceCurrent,
  handleComplianceRecord,
  handleStatusLineSnapshot,
  resolveComplianceDurationLabel,
  resolveComplianceDurationSeconds,
} from "./compliance-routes.ts"
import { UpstreamSyncRegistry } from "./upstream-sync.ts"

const taskCaches: TaskStateCache[] = []
const syncRegistries: UpstreamSyncRegistry[] = []

afterEach(() => {
  for (const cache of taskCaches.splice(0)) cache.close()
  for (const registry of syncRegistries.splice(0)) registry.close()
})

function snapshot(): WarmStatusLineSnapshot {
  return {
    shortCwd: "repo",
    gitInfo: "main",
    gitBranch: "main",
    activeSegments: [],
    issueCount: 0,
    prCount: 0,
    fetchStatus: "ok",
    reviewDecision: "",
    commentCount: 0,
    projectState: null,
    settingsParts: [],
  }
}

function createContext(): ComplianceRoutesContext {
  const taskStateCache = new TaskStateCache()
  const upstreamSyncRegistry = new UpstreamSyncRegistry({
    resolveSlug: async () => null,
    resolveFork: async () => null,
  })
  taskCaches.push(taskStateCache)
  syncRegistries.push(upstreamSyncRegistry)
  return {
    taskStateCache,
    resolveSnapshot: async () => snapshot(),
    sessionComplianceState: new CappedMap(20),
    upstreamSyncRegistry,
  }
}

function recordRequest(body: Record<string, unknown>): Request {
  return new Request("http://daemon/compliance/record", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

describe("compliance routes", () => {
  test("formats compliance durations in seconds, minutes, and hours", () => {
    const store = createContext().sessionComplianceState
    const now = Date.now()

    store.set("seconds", {
      current: { state: "working", at: now - 25_000 },
      transitions: [],
    })
    store.set("minutes", {
      current: { state: "working", at: now - 5 * 60_000 },
      transitions: [],
    })
    store.set("hours", {
      current: { state: "working", at: now - 2 * 60 * 60_000 },
      transitions: [],
    })

    expect(resolveComplianceDurationLabel("seconds", store)).toBe("25s")
    expect(resolveComplianceDurationLabel("minutes", store)).toBe("5m")
    expect(resolveComplianceDurationLabel("hours", store)).toBe("2h")
    expect(resolveComplianceDurationSeconds("minutes", store)).toBeGreaterThanOrEqual(300)
    expect(resolveComplianceDurationLabel("missing", store)).toBeNull()
  })

  test("records transitions and refreshes task durations without resetting start time", async () => {
    const ctx = createContext()
    const firstAt = Date.now() - 5_000

    const first = await handleComplianceRecord(
      recordRequest({ sessionId: "session", state: "working", at: firstAt }),
      ctx
    )
    const same = await handleComplianceRecord(
      recordRequest({
        sessionId: "session",
        state: "working",
        at: Date.now(),
        taskDurations: [{ id: "1", status: "in_progress", durationMs: 1000 }],
      }),
      ctx
    )
    const changed = await handleComplianceRecord(
      recordRequest({ sessionId: "session", state: "blocked", at: Date.now() }),
      ctx
    )

    expect(await first.json()).toEqual({ transitioned: true })
    expect(await same.json()).toEqual({ transitioned: false })
    expect(await changed.json()).toEqual({ transitioned: true })
    const stored = ctx.sessionComplianceState.get("session")
    expect(stored?.transitions).toHaveLength(2)
    expect(stored?.transitions[0]).toMatchObject({
      state: "working",
      at: firstAt,
      taskDurations: [{ id: "1", status: "in_progress", durationMs: 1000 }],
    })
  })

  test("rejects incomplete compliance records", async () => {
    const response = await handleComplianceRecord(
      recordRequest({ sessionId: "session" }),
      createContext()
    )
    expect(response.status).toBe(400)
  })

  test("returns the current compliance entry and validates sessionId", async () => {
    const ctx = createContext()
    ctx.sessionComplianceState.set("session", {
      current: { state: "working", at: 123 },
      transitions: [],
    })

    const missing = handleComplianceCurrent(new URL("http://daemon/compliance/current"), ctx)
    const present = handleComplianceCurrent(
      new URL("http://daemon/compliance/current?sessionId=session"),
      ctx
    )

    expect(missing.status).toBe(400)
    expect(await present.json()).toEqual({ current: { state: "working", at: 123 } })
  })

  test("validates snapshot cwd and enriches a snapshot without a session", async () => {
    const ctx = createContext()
    const invalid = new Request("http://daemon/status-line/snapshot", {
      method: "POST",
      body: "{}",
    })
    const valid = new Request("http://daemon/status-line/snapshot", {
      method: "POST",
      body: JSON.stringify({ cwd: "/repo" }),
    })

    expect((await handleStatusLineSnapshot(invalid, ctx)).status).toBe(400)
    const body = await handleStatusLineSnapshot(valid, ctx).then((response) => response.json())
    expect(body.snapshot).toMatchObject({
      shortCwd: "repo",
      taskCounts: null,
      complianceDurationLabel: null,
      complianceDurationSeconds: null,
      issueSyncStale: null,
    })
  })
})
