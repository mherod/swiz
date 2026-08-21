import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectKeyFromCwd } from "../../project-key.ts"
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
    sessionDivergence: new Map(),
    upstreamSyncRegistry,
  }
}

// The MCP task tools key the store by projectKeyFromCwd(cwd) while the native tools key it by
// session id, so a warm snapshot that reads only the session directory reports an empty queue for
// any session driven through MCP — no task segment, and a clean wanted level over open work.
const tempHomes: string[] = []

afterEach(async () => {
  for (const home of tempHomes.splice(0)) await rm(home, { recursive: true, force: true })
})

function withTempHome(): { home: string; restore: () => void } {
  const home = mkdtempSync(join(tmpdir(), "swiz-compliance-tasks-"))
  tempHomes.push(home)
  const previous = process.env.HOME
  process.env.HOME = home
  return {
    home,
    restore: () => {
      if (previous === undefined) delete process.env.HOME
      else process.env.HOME = previous
    },
  }
}

async function writeStoreTask(
  home: string,
  storeKey: string,
  id: string,
  status: string,
  completedAt?: number
): Promise<void> {
  const dir = join(home, ".claude", "tasks", storeKey)
  await mkdir(dir, { recursive: true })
  await Bun.write(
    join(dir, `${id}.json`),
    JSON.stringify({
      id,
      subject: `subject ${id}`,
      description: `description ${id}`,
      status,
      completedAt: completedAt ?? null,
      blocks: [],
      blockedBy: [],
    })
  )
}

async function snapshotOf(cwd: string, sessionId: string) {
  const request = new Request("http://daemon/status-line/snapshot", {
    method: "POST",
    body: JSON.stringify({ cwd, sessionId }),
  })
  const body = await handleStatusLineSnapshot(request, createContext()).then((res) => res.json())
  return body.snapshot
}

async function snapshotTaskCounts(cwd: string, sessionId: string) {
  return (await snapshotOf(cwd, sessionId)).taskCounts
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

  test("counts session-store tasks in the warm snapshot (control)", async () => {
    const { home, restore } = withTempHome()
    const cwd = "/repo/only-session"
    const sessionId = "00000000-0000-0000-0000-0000000000aa"
    await writeStoreTask(home, sessionId, "aaaa-1", "in_progress")

    try {
      // Without this control the union case below could pass for the wrong reason.
      expect(await snapshotTaskCounts(cwd, sessionId)).toMatchObject({ total: 1, inProgress: 1 })
    } finally {
      restore()
    }
  })

  test("never prunes completed tasks out of the project store", async () => {
    // TaskStateCache.fullLoad runs pruneStaleCompleted, which unlinks completed task files older
    // than COMPLETED_TASK_PRUNE_AGE_MS (15m). That is sound for the session store the daemon owns
    // and destructive for the long-lived project store, so the snapshot must read it from disk.
    const { home, restore } = withTempHome()
    const cwd = "/repo/prune-guard"
    const sessionId = "00000000-0000-0000-0000-0000000000ff"
    const projectKey = projectKeyFromCwd(cwd)
    await writeStoreTask(home, sessionId, "ffff-1", "in_progress")
    const staleCompletion = Date.now() - 60 * 60_000
    await writeStoreTask(home, projectKey, "349d-1", "completed", staleCompletion)

    try {
      await snapshotTaskCounts(cwd, sessionId)
      const completedPath = join(home, ".claude", "tasks", projectKey, "349d-1.json")
      expect(existsSync(completedPath)).toBe(true)
    } finally {
      restore()
    }
  })

  test("counts project-keyed MCP tasks in the warm snapshot", async () => {
    const { home, restore } = withTempHome()
    const cwd = "/repo/mcp-driven"
    const sessionId = "00000000-0000-0000-0000-0000000000bb"
    await writeStoreTask(home, sessionId, "bbbb-1", "in_progress")
    await writeStoreTask(home, projectKeyFromCwd(cwd), "349d-1", "pending")

    try {
      const snapshot = await snapshotOf(cwd, sessionId)
      expect(snapshot.taskCounts).toMatchObject({
        total: 2,
        incomplete: 2,
        pending: 1,
        inProgress: 1,
      })
      // Healthy merged queue: >=1 in_progress, >=1 pending, >=2 incomplete.
      expect(snapshot.wantedLevel).toBe(0)
    } finally {
      restore()
    }
  })

  test("raises the wanted level from a project-keyed queue alone", async () => {
    // complianceBaselineWantedLevel is derived from the merged counts, so a queue held entirely in
    // the project store used to read as counts=null — a clean wanted level over unhealthy work.
    const { home, restore } = withTempHome()
    const cwd = "/repo/wanted-level"
    const sessionId = "00000000-0000-0000-0000-0000000000aa"
    await writeStoreTask(home, projectKeyFromCwd(cwd), "349d-1", "pending")

    try {
      const snapshot = await snapshotOf(cwd, sessionId)
      expect(snapshot.taskCounts).toMatchObject({ total: 1, incomplete: 1, inProgress: 0 })
      // One pending task with nothing in progress is an unhealthy queue.
      expect(snapshot.wantedLevel).toBe(1)
    } finally {
      restore()
    }
  })
})
