import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LRUCache } from "lru-cache"
import type { Session } from "../transcript-utils.ts"
import { CappedMap } from "./daemon/cache/capped-map.ts"
import { CiWatchRegistry, verifyWebhookSignature } from "./daemon/ci-watch-registry.ts"
import {
  CooldownRegistry,
  createMetrics,
  FileWatcherRegistry,
  GhQueryCache,
  GitStateCache,
  HookEligibilityCache,
  ManifestCache,
  ProjectSettingsCache,
  recordDispatch,
  serializeMetrics,
  TranscriptIndexCache,
} from "./daemon/runtime-cache.ts"
import type { CachedSnapshot, SnapshotFingerprint } from "./daemon/snapshot.ts"
import { buildSnapshotFingerprint, hasSnapshotInvalidated } from "./daemon/snapshot.ts"
import type { CapturedToolCall, SessionToolUsageState } from "./daemon/utils.ts"
import { resolveComplianceDurationLabel } from "./daemon/web-server.ts"
import { DaemonWorkerRuntime } from "./daemon/worker-runtime.ts"
import {
  buildSnapshotResolver,
  deleteProjectSnapshots,
  hydratePersistedSessionToolState,
  snapshotCacheKey,
} from "./daemon.ts"
import type { WarmStatusLineSnapshot } from "./status-line.ts"

describe("project snapshot eviction", () => {
  it("keeps sibling project snapshots that share a path prefix", () => {
    const snapshots = new Map<string, object>([
      [snapshotCacheKey("/workspace/app", "session-a"), {}],
      [snapshotCacheKey("/workspace/app", "session-b"), {}],
      [snapshotCacheKey("/workspace/app-api", "session-c"), {}],
    ])

    deleteProjectSnapshots(snapshots, "/workspace/app")

    expect(snapshots.has(snapshotCacheKey("/workspace/app", "session-a"))).toBeFalse()
    expect(snapshots.has(snapshotCacheKey("/workspace/app", "session-b"))).toBeFalse()
    expect(snapshots.has(snapshotCacheKey("/workspace/app-api", "session-c"))).toBeTrue()
  })
})

describe("buildSnapshotResolver", () => {
  const dummySnapshot: WarmStatusLineSnapshot = {
    shortCwd: "/workspace/project",
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

  const baseFingerprint: SnapshotFingerprint = {
    projectSettingsMtimeMs: 100,
    projectStateMtimeMs: 200,
    globalSettingsMtimeMs: 300,
    ghCacheMtimeMs: 400,
    githubBucket: 10,
  }

  it("serves warm hits without recomputing snapshot when fingerprint is unchanged", async () => {
    const snapshots = new LRUCache<string, CachedSnapshot>({ max: 10 })
    let computeCount = 0
    let fingerprintCount = 0

    const resolver = buildSnapshotResolver(snapshots, {
      buildFingerprint: async () => {
        fingerprintCount++
        return { ...baseFingerprint }
      },
      computeSnapshot: async () => {
        computeCount++
        return { ...dummySnapshot }
      },
    })

    // Cold miss
    const res1 = await resolver("/workspace/project", "sess1")
    expect(res1.gitBranch).toBe("main")
    expect(computeCount).toBe(1)
    expect(fingerprintCount).toBe(1)

    // Warm hit: cheap fingerprint checked, zero computeSnapshot / Git work
    const res2 = await resolver("/workspace/project", "sess1")
    expect(res2).toEqual(res1)
    expect(computeCount).toBe(1)
    expect(fingerprintCount).toBe(2)
  })

  it("recomputes when non-Git mtime changes", async () => {
    const snapshots = new LRUCache<string, CachedSnapshot>({ max: 10 })
    let computeCount = 0
    let currentFingerprint = { ...baseFingerprint }

    const resolver = buildSnapshotResolver(snapshots, {
      buildFingerprint: async () => ({ ...currentFingerprint }),
      computeSnapshot: async () => {
        computeCount++
        return { ...dummySnapshot, issueCount: computeCount }
      },
    })

    await resolver("/workspace/project", "sess1")
    expect(computeCount).toBe(1)

    // Modify project settings mtime
    currentFingerprint = { ...baseFingerprint, projectSettingsMtimeMs: 101 }
    const res2 = await resolver("/workspace/project", "sess1")
    expect(computeCount).toBe(2)
    expect(res2.issueCount).toBe(2)
  })

  it("recomputes when 20s githubBucket changes", async () => {
    const snapshots = new LRUCache<string, CachedSnapshot>({ max: 10 })
    let computeCount = 0
    let currentFingerprint = { ...baseFingerprint }

    const resolver = buildSnapshotResolver(snapshots, {
      buildFingerprint: async () => ({ ...currentFingerprint }),
      computeSnapshot: async () => {
        computeCount++
        return { ...dummySnapshot, prCount: computeCount }
      },
    })

    await resolver("/workspace/project", "sess1")
    expect(computeCount).toBe(1)

    // Advance bucket from 10 to 11
    currentFingerprint = { ...baseFingerprint, githubBucket: 11 }
    const res2 = await resolver("/workspace/project", "sess1")
    expect(computeCount).toBe(2)
    expect(res2.prCount).toBe(2)
  })

  it("recomputes after watcher deletes project snapshots", async () => {
    const snapshots = new LRUCache<string, CachedSnapshot>({ max: 10 })
    let computeCount = 0

    const resolver = buildSnapshotResolver(snapshots, {
      buildFingerprint: async () => ({ ...baseFingerprint }),
      computeSnapshot: async (_cwd, _sess) => {
        computeCount++
        return { ...dummySnapshot, gitBranch: computeCount === 1 ? "main" : "feature" }
      },
    })

    const res1 = await resolver("/workspace/project", "sess1")
    expect(res1.gitBranch).toBe("main")
    expect(computeCount).toBe(1)

    // Simulate .git/ watcher event triggering project flush
    deleteProjectSnapshots(snapshots, "/workspace/project")

    const res2 = await resolver("/workspace/project", "sess1")
    expect(res2.gitBranch).toBe("feature")
    expect(computeCount).toBe(2)
  })

  it("coalesces concurrent in-flight requests into one computation", async () => {
    const snapshots = new LRUCache<string, CachedSnapshot>({ max: 10 })
    let computeCount = 0

    const resolver = buildSnapshotResolver(snapshots, {
      buildFingerprint: async () => ({ ...baseFingerprint }),
      computeSnapshot: async () => {
        computeCount++
        await Bun.sleep(20)
        return { ...dummySnapshot }
      },
    })

    const p1 = resolver("/workspace/project", "sess1")
    await Bun.sleep(2)
    const p2 = resolver("/workspace/project", "sess1")

    expect(p2).toBe(p1)
    const [res1, res2] = await Promise.all([p1, p2])
    expect(res1).toEqual(res2)
    expect(computeCount).toBe(1)
  })

  it("cleans up inFlight map after rejected computation and permits retries", async () => {
    const snapshots = new LRUCache<string, CachedSnapshot>({ max: 10 })
    let computeCount = 0
    const testError = new Error("disk failure")

    const resolver = buildSnapshotResolver(snapshots, {
      buildFingerprint: async () => ({ ...baseFingerprint }),
      computeSnapshot: async () => {
        computeCount++
        if (computeCount === 1) throw testError
        return { ...dummySnapshot }
      },
    })

    // First attempt fails
    let err: unknown
    try {
      await resolver("/workspace/project", "sess1")
    } catch (e) {
      err = e
    }
    expect(err).toBe(testError)
    expect(computeCount).toBe(1)

    // Second attempt retries and succeeds because inFlight was cleaned up
    const res2 = await resolver("/workspace/project", "sess1")
    expect(res2.gitBranch).toBe("main")
    expect(computeCount).toBe(2)
  })

  it("differentiates sessions under the same cwd", async () => {
    const snapshots = new LRUCache<string, CachedSnapshot>({ max: 10 })
    let computeCount = 0

    const resolver = buildSnapshotResolver(snapshots, {
      buildFingerprint: async () => ({ ...baseFingerprint }),
      computeSnapshot: async (_cwd, sessionId) => {
        computeCount++
        return { ...dummySnapshot, shortCwd: `${sessionId}` }
      },
    })

    const res1 = await resolver("/workspace/project", "sess-1")
    const res2 = await resolver("/workspace/project", "sess-2")

    expect(res1.shortCwd).toBe("sess-1")
    expect(res2.shortCwd).toBe("sess-2")
    expect(computeCount).toBe(2)
  })
})

describe("hasSnapshotInvalidated", () => {
  const base: SnapshotFingerprint = {
    projectSettingsMtimeMs: 100,
    projectStateMtimeMs: 200,
    globalSettingsMtimeMs: 300,
    ghCacheMtimeMs: 400,
    githubBucket: 10,
  }

  it("invalidates when no previous fingerprint exists", () => {
    expect(hasSnapshotInvalidated(null, base)).toBeTrue()
  })

  it("keeps warm snapshot when fingerprint is unchanged", () => {
    expect(hasSnapshotInvalidated(base, { ...base })).toBeFalse()
  })

  it("invalidates when project settings mtime changes", () => {
    expect(hasSnapshotInvalidated(base, { ...base, projectSettingsMtimeMs: 101 })).toBeTrue()
  })

  it("invalidates when project state mtime changes", () => {
    expect(hasSnapshotInvalidated(base, { ...base, projectStateMtimeMs: 201 })).toBeTrue()
  })

  it("invalidates when global settings mtime changes", () => {
    expect(hasSnapshotInvalidated(base, { ...base, globalSettingsMtimeMs: 301 })).toBeTrue()
  })

  it("invalidates when gh cache mtime changes", () => {
    expect(hasSnapshotInvalidated(base, { ...base, ghCacheMtimeMs: 401 })).toBeTrue()
  })

  it("invalidates on github refresh bucket change", () => {
    expect(hasSnapshotInvalidated(base, { ...base, githubBucket: 11 })).toBeTrue()
  })
})

describe("buildSnapshotFingerprint", () => {
  it("computes fingerprint with non-Git mtimes and 20s githubBucket", async () => {
    const fixedNow = 1_700_000_000_000
    const expectedBucket = Math.floor(fixedNow / 20_000)
    const fp = await buildSnapshotFingerprint(process.cwd(), fixedNow)

    expect(fp.githubBucket).toBe(expectedBucket)
    expect(typeof fp.projectSettingsMtimeMs).toBe("number")
    expect(typeof fp.projectStateMtimeMs).toBe("number")
    expect(typeof fp.globalSettingsMtimeMs).toBe("number")
    expect(typeof fp.ghCacheMtimeMs).toBe("number")
    expect((fp as any).git).toBeUndefined()
  })
})

describe("CiWatchRegistry", () => {
  it("deduplicates active watches by cwd+sha", () => {
    const registry = new CiWatchRegistry({
      pollMs: 1000,
      timeoutMs: 10_000,
      fetchRun: async () => null,
      notify: async () => {},
    })

    const first = registry.start("/repo", "abc123")
    const second = registry.start("/repo", "abc123")

    expect(first.deduped).toBeFalse()
    expect(second.deduped).toBeTrue()
    expect(registry.listActive()).toHaveLength(1)
    registry.close()
  })

  it("completes and notifies when run reaches completed status", async () => {
    const notifications: string[] = []
    let polls = 0

    const registry = new CiWatchRegistry({
      pollMs: 1000,
      timeoutMs: 5000,
      fetchRun: async () => {
        polls += 1
        if (polls < 2) return null
        return {
          databaseId: 99,
          status: "completed",
          conclusion: "success",
          url: "https://github.com/mherod/swiz/actions/runs/99",
        }
      },
      notify: async (watch) => {
        notifications.push(`${watch.conclusion}:${watch.runId}`)
      },
    })

    registry.start("/repo", "abc123")
    const waitUntil = Date.now() + 5000
    while (notifications.length === 0 && Date.now() < waitUntil) {
      await Bun.sleep(20)
    }
    expect(notifications).toEqual(["success:99"])
    expect(registry.listActive()).toHaveLength(0)
    registry.close()
  })
})

describe("DaemonWorkerRuntime", () => {
  it("uses worker transport when available", async () => {
    let requests = 0
    const runtime = new DaemonWorkerRuntime({
      enabled: true,
      transportFactory: () => ({
        request: async (_payloadStr: string) => {
          requests += 1
          return {
            cwd: "/repo",
            sessionId: "session-1",
            transcriptPath: null,
            toolName: "Shell",
            toolInput: { command: "ls" },
          }
        },
        close: () => {},
      }),
    })

    const result = await runtime.parseDispatchPayload('{"cwd":"/repo"}')
    expect(result).toEqual({
      cwd: "/repo",
      sessionId: "session-1",
      transcriptPath: null,
      toolName: "Shell",
      toolInput: { command: "ls" },
    })
    expect(requests).toBe(1)
    runtime.close()
  })

  it("falls back to in-thread parse when worker startup fails", async () => {
    const runtime = new DaemonWorkerRuntime({
      enabled: true,
      transportFactory: () => {
        throw new Error("worker unavailable")
      },
    })

    const result = await runtime.parseDispatchPayload(
      JSON.stringify({
        cwd: "/repo",
        session_id: "abc",
        tool_name: "Shell",
        tool_input: { command: "echo hi" },
      })
    )
    expect(result).toEqual({
      cwd: "/repo",
      sessionId: "abc",
      transcriptPath: null,
      toolName: "Shell",
      toolInput: { command: "echo hi" },
    })
  })

  it("falls back to in-thread parse when worker request errors", async () => {
    const runtime = new DaemonWorkerRuntime({
      enabled: true,
      transportFactory: () => ({
        request: async () => {
          throw new Error("postMessage failed")
        },
        close: () => {},
      }),
    })

    const result = await runtime.parseDispatchPayload(
      JSON.stringify({
        cwd: "/repo",
        session_id: "abc",
        toolName: "ReadFile",
        toolInput: { path: "/tmp/file.ts" },
      })
    )
    expect(result).toEqual({
      cwd: "/repo",
      sessionId: "abc",
      transcriptPath: null,
      toolName: "ReadFile",
      toolInput: { path: "/tmp/file.ts" },
    })
    runtime.close()
  })
})

describe("hydratePersistedSessionToolState", () => {
  it("seeds recovered tool calls, usage, and activity from persisted JSONL state", async () => {
    const state = {
      sessionActivity: new Map<string, { lastSeen: number; dispatches: number }>(),
      sessionToolCalls: new Map<string, CapturedToolCall[]>(),
      sessionToolUsage: new Map<string, SessionToolUsageState>(),
    }

    const sessions: Session[] = [
      {
        id: "session-1",
        path: "/tmp/transcript.jsonl",
        mtime: 1_700_000_000_000,
        provider: "cursor",
        format: "cursor-agent-jsonl",
      },
    ]
    const recoveredCalls: CapturedToolCall[] = [
      { name: "Read", detail: "/tmp/file.ts", timestamp: "2026-04-03T10:00:00.000Z" },
      { name: "Skill", detail: "commit --amend", timestamp: "2026-04-03T10:01:00.000Z" },
    ]

    const count = await hydratePersistedSessionToolState("/repo", state, {
      listSessions: async () => sessions,
      readToolCalls: async (_cwd, sessionId) => (sessionId === "session-1" ? recoveredCalls : []),
      nowMs: Date.parse("2026-04-03T10:05:00.000Z"),
    })

    expect(count).toBe(1)
    expect(state.sessionToolCalls.get("session-1")).toEqual(recoveredCalls)
    expect(state.sessionToolUsage.get("session-1")).toEqual({
      toolNames: ["Read", "Skill"],
      skillInvocations: ["commit"],
      readFiles: ["/tmp/file.ts"],
      writtenFiles: [],
      events: [
        {
          kind: "tool",
          value: "Read",
          turnIndex: 0,
          timestamp: "2026-04-03T10:00:00.000Z",
        },
        {
          kind: "read-file",
          value: "/tmp/file.ts",
          turnIndex: 0,
          timestamp: "2026-04-03T10:00:00.000Z",
          source: "agent",
        },
        {
          kind: "tool",
          value: "Skill",
          turnIndex: 1,
          timestamp: "2026-04-03T10:01:00.000Z",
        },
        {
          kind: "skill",
          value: "commit",
          turnIndex: 1,
          timestamp: "2026-04-03T10:01:00.000Z",
          source: "agent",
        },
      ],
      lastSeen: Date.parse("2026-04-03T10:01:00.000Z"),
      nextTurnIndex: 2,
    })
    expect(state.sessionActivity.get("session-1")).toEqual({
      lastSeen: Date.parse("2026-04-03T10:01:00.000Z"),
      dispatches: 0,
    })
  })

  it("merges recovered state into existing in-memory session data", async () => {
    const state = {
      sessionActivity: new Map<string, { lastSeen: number; dispatches: number }>([
        ["session-1", { lastSeen: 10, dispatches: 2 }],
      ]),
      sessionToolCalls: new Map<string, CapturedToolCall[]>([
        [
          "session-1",
          [{ name: "Read", detail: "/tmp/file.ts", timestamp: "2026-04-03T10:00:00.000Z" }],
        ],
      ]),
      sessionToolUsage: new Map<string, SessionToolUsageState>([
        [
          "session-1",
          {
            toolNames: ["Read"],
            skillInvocations: [],
            events: [{ kind: "tool", value: "Read", turnIndex: 0, timestamp: null }],
            lastSeen: 10,
          },
        ],
      ]),
    }

    const count = await hydratePersistedSessionToolState("/repo", state, {
      listSessions: async () => [
        {
          id: "session-1",
          path: "/tmp/transcript.jsonl",
          mtime: 20,
          provider: "cursor",
          format: "cursor-agent-jsonl",
        },
      ],
      readToolCalls: async () => [
        { name: "Read", detail: "/tmp/file.ts", timestamp: "2026-04-03T10:00:00.000Z" },
        { name: "Bash", detail: "ls", timestamp: "2026-04-03T10:02:00.000Z" },
      ],
      nowMs: Date.parse("2026-04-03T10:05:00.000Z"),
    })

    expect(count).toBe(1)
    expect(state.sessionToolCalls.get("session-1")).toEqual([
      { name: "Read", detail: "/tmp/file.ts", timestamp: "2026-04-03T10:00:00.000Z" },
      { name: "Bash", detail: "ls", timestamp: "2026-04-03T10:02:00.000Z" },
    ])
    expect(state.sessionToolUsage.get("session-1")).toEqual({
      toolNames: ["Read", "Read", "Bash"],
      skillInvocations: [],
      readFiles: ["/tmp/file.ts"],
      writtenFiles: [],
      events: [
        { kind: "tool", value: "Read", turnIndex: 0, timestamp: null },
        {
          kind: "tool",
          value: "Read",
          turnIndex: 0,
          timestamp: "2026-04-03T10:00:00.000Z",
        },
        {
          kind: "read-file",
          value: "/tmp/file.ts",
          turnIndex: 0,
          timestamp: "2026-04-03T10:00:00.000Z",
          source: "agent",
        },
        {
          kind: "tool",
          value: "Bash",
          turnIndex: 1,
          timestamp: "2026-04-03T10:02:00.000Z",
        },
      ],
      lastSeen: Date.parse("2026-04-03T10:02:00.000Z"),
      nextTurnIndex: 3,
    })
    expect(state.sessionActivity.get("session-1")).toEqual({
      lastSeen: Date.parse("2026-04-03T10:02:00.000Z"),
      dispatches: 2,
    })
  })

  it("discovers up to 30 sessions, limits read concurrency to 4, and inserts oldest-to-newest into CappedMaps", async () => {
    const baseTime = Date.parse("2026-04-03T12:00:00.000Z")
    // 100 sessions from s0 (newest, mtime = baseTime) down to s99 (oldest, mtime = baseTime - 99s)
    const sessions: Session[] = Array.from({ length: 100 }, (_, i) => ({
      id: `s${i}`,
      path: `/tmp/session-${i}.jsonl`,
      mtime: baseTime - i * 1_000,
      provider: "claude",
      format: "jsonl",
    }))

    const readSessions: string[] = []
    let inFlight = 0
    let peakConcurrency = 0

    const readToolCalls = async (_cwd: string, sessionId: string): Promise<CapturedToolCall[]> => {
      readSessions.push(sessionId)
      inFlight++
      peakConcurrency = Math.max(peakConcurrency, inFlight)
      await Bun.sleep(5)
      inFlight--
      const idx = Number.parseInt(sessionId.slice(1), 10)
      const ts = new Date(baseTime - idx * 1_000).toISOString()
      return [{ name: "Read", detail: `/file-${idx}.ts`, timestamp: ts }]
    }

    const state = {
      sessionActivity: new CappedMap<string, { lastSeen: number; dispatches: number }>(10),
      sessionToolCalls: new CappedMap<string, CapturedToolCall[]>(10),
      sessionToolUsage: new CappedMap<string, SessionToolUsageState>(30),
    }

    const count = await hydratePersistedSessionToolState("/repo", state, {
      listSessions: async () => sessions,
      readToolCalls,
      nowMs: baseTime + 10_000,
    })

    expect(count).toBe(30)
    expect(readSessions).toHaveLength(30)
    expect(peakConcurrency).toBeLessThanOrEqual(4)

    // sessionToolUsage (cap 30) should contain the newest 30 sessions: s29..s0
    expect(state.sessionToolUsage.size).toBe(30)
    const usageKeys = Array.from(state.sessionToolUsage.keys())
    const expected30Newest = Array.from({ length: 30 }, (_, i) => `s${29 - i}`)
    expect(usageKeys).toEqual(expected30Newest)

    // sessionToolCalls (cap 10) should contain the newest 10 sessions (s9..s0), NOT the oldest (s29..s20)
    expect(state.sessionToolCalls.size).toBe(10)
    const toolCallKeys = Array.from(state.sessionToolCalls.keys())
    const expected10Newest = Array.from({ length: 10 }, (_, i) => `s${9 - i}`)
    expect(toolCallKeys).toEqual(expected10Newest)

    // sessionActivity (cap 10) should also contain the newest 10 sessions
    expect(state.sessionActivity.size).toBe(10)
    const activityKeys = Array.from(state.sessionActivity.keys())
    expect(activityKeys).toEqual(expected10Newest)
  })

  it("skips sessions older than the 30-minute retention cutoff", async () => {
    const nowMs = Date.parse("2026-04-03T12:00:00.000Z")
    const recentTime = nowMs - 5 * 60 * 1000 // 5 mins ago
    const staleTime = nowMs - 35 * 60 * 1000 // 35 mins ago

    const sessions: Session[] = [
      {
        id: "s-recent",
        path: "/tmp/s-recent.jsonl",
        mtime: recentTime,
        provider: "claude",
        format: "jsonl",
      },
      {
        id: "s-stale",
        path: "/tmp/s-stale.jsonl",
        mtime: staleTime,
        provider: "claude",
        format: "jsonl",
      },
    ]

    const state = {
      sessionActivity: new CappedMap<string, { lastSeen: number; dispatches: number }>(10),
      sessionToolCalls: new CappedMap<string, CapturedToolCall[]>(10),
      sessionToolUsage: new CappedMap<string, SessionToolUsageState>(30),
    }

    const count = await hydratePersistedSessionToolState("/repo", state, {
      listSessions: async () => sessions,
      readToolCalls: async (_cwd, sessionId) => {
        const ts =
          sessionId === "s-recent"
            ? new Date(recentTime).toISOString()
            : new Date(staleTime).toISOString()
        return [{ name: "Read", detail: "/file.ts", timestamp: ts }]
      },
      nowMs,
    })

    expect(count).toBe(1)
    expect(state.sessionToolCalls.has("s-recent")).toBe(true)
    expect(state.sessionToolCalls.has("s-stale")).toBe(false)
    expect(state.sessionToolUsage.has("s-recent")).toBe(true)
    expect(state.sessionToolUsage.has("s-stale")).toBe(false)
    expect(state.sessionActivity.has("s-recent")).toBe(true)
    expect(state.sessionActivity.has("s-stale")).toBe(false)
  })

  it("handles single-session read failure fail-open without disturbing insertion order of remaining sessions", async () => {
    const baseTime = Date.parse("2026-04-03T12:00:00.000Z")
    const sessions: Session[] = [
      { id: "s0", path: "/tmp/s0.jsonl", mtime: baseTime, provider: "claude", format: "jsonl" },
      {
        id: "s1",
        path: "/tmp/s1.jsonl",
        mtime: baseTime - 1000,
        provider: "claude",
        format: "jsonl",
      },
      {
        id: "s2",
        path: "/tmp/s2.jsonl",
        mtime: baseTime - 2000,
        provider: "claude",
        format: "jsonl",
      },
      {
        id: "s3",
        path: "/tmp/s3.jsonl",
        mtime: baseTime - 3000,
        provider: "claude",
        format: "jsonl",
      },
    ]

    const state = {
      sessionActivity: new CappedMap<string, { lastSeen: number; dispatches: number }>(10),
      sessionToolCalls: new CappedMap<string, CapturedToolCall[]>(10),
      sessionToolUsage: new CappedMap<string, SessionToolUsageState>(30),
    }

    const count = await hydratePersistedSessionToolState("/repo", state, {
      listSessions: async () => sessions,
      readToolCalls: async (_cwd, sessionId) => {
        if (sessionId === "s2") throw new Error("Disk corruption")
        return [
          { name: "Read", detail: `/${sessionId}.ts`, timestamp: new Date(baseTime).toISOString() },
        ]
      },
      nowMs: baseTime + 10_000,
    })

    expect(count).toBe(3)
    expect(state.sessionToolUsage.has("s2")).toBe(false)
    // Applied in oldest-to-newest order: s3, s1, s0
    expect(Array.from(state.sessionToolUsage.keys())).toEqual(["s3", "s1", "s0"])
  })
})

describe("daemon metrics", () => {
  it("creates metrics with empty dispatches", () => {
    const m = createMetrics()
    expect(m.dispatches.size).toBe(0)
    expect(m.startedAt).toBeGreaterThan(0)
  })

  it("records dispatches and accumulates counts", () => {
    const m = createMetrics()
    recordDispatch(m, "preToolUse", 10)
    recordDispatch(m, "preToolUse", 20)
    recordDispatch(m, "postToolUse", 5)

    const pre = m.dispatches.get("preToolUse")
    expect(pre?.count).toBe(2)
    expect(pre?.totalMs).toBe(30)

    const post = m.dispatches.get("postToolUse")
    expect(post?.count).toBe(1)
    expect(post?.totalMs).toBe(5)
  })

  it("serializes metrics with averages", () => {
    const m = createMetrics()
    recordDispatch(m, "preToolUse", 10)
    recordDispatch(m, "preToolUse", 30)

    const serialized = serializeMetrics(m)
    expect(serialized.totalDispatches).toBe(2)
    expect(serialized.byEvent.preToolUse?.count).toBe(2)
    expect(serialized.byEvent.preToolUse?.avgMs).toBe(20)
    expect(serialized.uptimeMs).toBeGreaterThanOrEqual(0)
    expect(serialized.uptimeHuman).toMatch(/^\d+s$/)
  })

  it("serializes empty metrics", () => {
    const m = createMetrics()
    const serialized = serializeMetrics(m)
    expect(serialized.totalDispatches).toBe(0)
    expect(Object.keys(serialized.byEvent)).toHaveLength(0)
  })
})

describe("FileWatcherRegistry", () => {
  const registries: FileWatcherRegistry[] = []
  afterEach(() => {
    for (const r of registries) r.close()
    registries.length = 0
  })

  it("registers paths and reports status", () => {
    const reg = new FileWatcherRegistry()
    registries.push(reg)
    reg.register("/tmp/test-path", "test-label", () => {})
    const status = reg.status()
    expect(status).toHaveLength(1)
    expect(status[0]?.label).toBe("test-label")
    expect(status[0]?.watching).toBeFalse()
    expect(status[0]?.invalidationCount).toBe(0)
  })

  it("multiple callbacks on same path", () => {
    const reg = new FileWatcherRegistry()
    registries.push(reg)
    const calls: string[] = []
    reg.register("/tmp/test-path", "test", () => calls.push("a"))
    reg.register("/tmp/test-path", "test", () => calls.push("b"))
    const status = reg.status()
    expect(status).toHaveLength(1)
  })

  it("close stops all watchers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fwr-close-"))
    try {
      const reg = new FileWatcherRegistry()
      registries.push(reg)
      reg.register(dir, "tmp", () => {})
      await reg.start()
      expect(reg.status()[0]?.watching).toBeTrue()
      reg.close()
      expect(reg.status()[0]?.watching).toBeFalse()
    } finally {
      try {
        await rm(dir, { recursive: true, force: true })
      } catch {}
    }
  })

  it("start ignores non-existent paths gracefully", async () => {
    const reg = new FileWatcherRegistry()
    registries.push(reg)
    reg.register("/nonexistent/path/that/does/not/exist", "missing", () => {})
    await reg.start()
    expect(reg.status()[0]?.watching).toBeFalse()
    reg.close()
  })
})

describe("GhQueryCache", () => {
  it("returns miss on first call and caches the result", async () => {
    let calls = 0
    const cache = new GhQueryCache(async () => {
      calls++
      return { data: "test" }
    })

    const r1 = await cache.get(["pr", "list"], "/repo")
    expect(r1.hit).toBeFalse()
    expect(r1.value).toEqual({ data: "test" })
    expect(calls).toBe(1)

    const r2 = await cache.get(["pr", "list"], "/repo")
    expect(r2.hit).toBeTrue()
    expect(r2.value).toEqual({ data: "test" })
    expect(calls).toBe(1)
  })

  it("caches different args independently", async () => {
    let calls = 0
    const cache = new GhQueryCache(async (_args) => {
      calls++
      return calls
    })

    await cache.get(["pr", "list"], "/repo")
    await cache.get(["issue", "list"], "/repo")
    expect(calls).toBe(2)
    expect(cache.size).toBe(2)
  })

  it("caches different cwds independently", async () => {
    let calls = 0
    const cache = new GhQueryCache(async () => {
      calls++
      return calls
    })

    await cache.get(["pr", "list"], "/repo-a")
    await cache.get(["pr", "list"], "/repo-b")
    expect(calls).toBe(2)
    expect(cache.size).toBe(2)
  })

  it("invalidateProject flushes only matching entries", async () => {
    const cache = new GhQueryCache(async () => "val")

    await cache.get(["pr", "list"], "/repo-a")
    await cache.get(["pr", "list"], "/repo-b")
    expect(cache.size).toBe(2)

    cache.invalidateProject("/repo-a")
    expect(cache.size).toBe(1)

    const r = await cache.get(["pr", "list"], "/repo-b")
    expect(r.hit).toBeTrue()
  })

  it("invalidateAll flushes everything", async () => {
    const cache = new GhQueryCache(async () => "val")

    await cache.get(["pr", "list"], "/repo-a")
    await cache.get(["issue", "list"], "/repo-b")
    expect(cache.size).toBe(2)

    cache.invalidateAll()
    expect(cache.size).toBe(0)
  })
})

describe("HookEligibilityCache", () => {
  it("computes and caches eligibility for a project", async () => {
    const cache = new HookEligibilityCache()
    const snapshot = await cache.compute(process.cwd())

    expect(snapshot.computedAt).toBeGreaterThan(0)
    expect(Array.isArray(snapshot.disabledHooks)).toBeTrue()
    expect(Array.isArray(snapshot.detectedStacks)).toBeTrue()
    expect(typeof snapshot.prMergeActive).toBe("boolean")
    expect(typeof snapshot.conditionResults).toBe("object")
    expect(cache.size).toBe(1)
  })

  it("returns cached result on second call", async () => {
    const cache = new HookEligibilityCache()
    const s1 = await cache.compute(process.cwd())
    const s2 = await cache.compute(process.cwd())

    expect(s1).toBe(s2) // same reference — cached
  })

  it("caches different projects independently", async () => {
    const cache = new HookEligibilityCache()
    await cache.compute("/tmp/project-a")
    await cache.compute("/tmp/project-b")
    expect(cache.size).toBe(2)
  })

  it("invalidateProject flushes only matching entries", async () => {
    const cache = new HookEligibilityCache()
    await cache.compute("/tmp/project-a")
    await cache.compute("/tmp/project-b")
    expect(cache.size).toBe(2)

    cache.invalidateProject("/tmp/project-a")
    expect(cache.size).toBe(1)
  })

  it("invalidateAll flushes everything", async () => {
    const cache = new HookEligibilityCache()
    await cache.compute("/tmp/project-a")
    await cache.compute("/tmp/project-b")
    expect(cache.size).toBe(2)

    cache.invalidateAll()
    expect(cache.size).toBe(0)
  })

  it("detects stacks for the current project", async () => {
    const cache = new HookEligibilityCache()
    const snapshot = await cache.compute(process.cwd())

    // This project uses bun
    expect(snapshot.detectedStacks).toContain("bun")
  })
})

describe("TranscriptIndexCache", () => {
  it("indexes a transcript file and caches by mtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "daemon-test-"))
    const tp = join(dir, "transcript.jsonl")
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Read", input: { file_path: "/a" } }],
        },
      }),
    ]
    await writeFile(tp, lines.join("\n"))

    const cache = new TranscriptIndexCache()
    const index = await cache.get(tp)
    expect(index).not.toBeNull()
    expect(index!.summary.toolCallCount).toBe(2)
    expect(index!.summary.toolNames).toEqual(["Bash", "Read"])
    expect(index!.summary.bashCommands).toEqual(["ls"])
    expect(cache.size).toBe(1)

    // Second call returns same cached entry (same mtime)
    const index2 = await cache.get(tp)
    expect(index2).toBe(index) // same reference
  })

  it("returns null for non-existent file", async () => {
    const cache = new TranscriptIndexCache()
    const index = await cache.get("/nonexistent/transcript.jsonl")
    expect(index).toBeNull()
    expect(cache.size).toBe(0)
  })

  it("detects blocked tool_use IDs from 'You must act on this now'", async () => {
    const dir = await mkdtemp(join(tmpdir(), "daemon-test-"))
    const tp = join(dir, "transcript.jsonl")
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "tu_1", name: "Edit", input: {} }],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: "Hook denied. You must act on this now: fix the issue.",
            },
          ],
        },
      }),
    ]
    await writeFile(tp, lines.join("\n"))

    const cache = new TranscriptIndexCache()
    const index = await cache.get(tp)
    expect(index).not.toBeNull()
    expect(index!.blockedToolUseIds).toContain("tu_1")
  })

  it("strips sessionLines from cached summary to prevent GB-scale memory leak", async () => {
    const dir = await mkdtemp(join(tmpdir(), "daemon-test-"))
    const tp = join(dir, "transcript.jsonl")
    // Large-ish line simulating a tool_result with file content
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/a" } }] },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "x".repeat(1000) }],
        },
      }),
    ]
    await writeFile(tp, lines.join("\n"))
    const cache = new TranscriptIndexCache()
    const index = await cache.get(tp)
    expect(index).not.toBeNull()
    // sessionLines must be stripped — raw JSONL lines can be GB for large sessions
    expect(index!.summary.sessionLines).toEqual([])
    // Derived fields must still be populated
    expect(index!.summary.toolCallCount).toBe(1)
    expect(index!.summary.toolNames).toEqual(["Read"])
  })

  it("invalidateAll clears all entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "daemon-test-"))
    const tp = join(dir, "transcript.jsonl")
    await writeFile(tp, JSON.stringify({ type: "assistant", message: { content: [] } }))

    const cache = new TranscriptIndexCache()
    await cache.get(tp)
    expect(cache.size).toBe(1)

    cache.invalidateAll()
    expect(cache.size).toBe(0)
  })

  it("re-indexes when file mtime changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "daemon-test-"))
    const tp = join(dir, "transcript.jsonl")
    await writeFile(
      tp,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
      })
    )

    const cache = new TranscriptIndexCache()
    const index1 = await cache.get(tp)
    expect(index1!.summary.toolCallCount).toBe(1)

    // Wait briefly to ensure mtime differs, then append a line
    await Bun.sleep(50)
    await writeFile(
      tp,
      [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Bash", input: { command: "echo hi" } }] },
        }),
      ].join("\n")
    )

    const index2 = await cache.get(tp)
    expect(index2).not.toBe(index1) // different reference — re-indexed
    expect(index2!.summary.toolCallCount).toBe(2)
  })
})

describe("CooldownRegistry", () => {
  it("returns false when no cooldown has been marked", () => {
    const reg = new CooldownRegistry()
    expect(reg.isWithinCooldown("hook-a.ts", 60, "/repo")).toBeFalse()
  })

  it("returns true when within cooldown window", () => {
    const reg = new CooldownRegistry()
    reg.mark("hook-a.ts", "/repo")
    expect(reg.isWithinCooldown("hook-a.ts", 60, "/repo")).toBeTrue()
  })

  it("returns false after cooldown expires", () => {
    const reg = new CooldownRegistry()
    // Manually set a timestamp in the past
    ;(reg as unknown as { entries: Map<string, number> }).entries.set(
      "hook-a.ts\x00/repo",
      Date.now() - 120_000 // 2 minutes ago
    )
    expect(reg.isWithinCooldown("hook-a.ts", 60, "/repo")).toBeFalse()
  })

  it("isolates different cwds", () => {
    const reg = new CooldownRegistry()
    reg.mark("hook-a.ts", "/repo-a")
    expect(reg.isWithinCooldown("hook-a.ts", 60, "/repo-a")).toBeTrue()
    expect(reg.isWithinCooldown("hook-a.ts", 60, "/repo-b")).toBeFalse()
  })

  it("isolates different hook files", () => {
    const reg = new CooldownRegistry()
    reg.mark("hook-a.ts", "/repo")
    expect(reg.isWithinCooldown("hook-a.ts", 60, "/repo")).toBeTrue()
    expect(reg.isWithinCooldown("hook-b.ts", 60, "/repo")).toBeFalse()
  })

  it("checkAndMark returns false on first call and true on second", () => {
    const reg = new CooldownRegistry()
    expect(reg.checkAndMark("hook-a.ts", 60, "/repo")).toBeFalse()
    expect(reg.checkAndMark("hook-a.ts", 60, "/repo")).toBeTrue()
  })

  it("invalidateProject flushes only matching entries", () => {
    const reg = new CooldownRegistry()
    reg.mark("hook-a.ts", "/repo-a")
    reg.mark("hook-a.ts", "/repo-b")
    expect(reg.size).toBe(2)

    reg.invalidateProject("/repo-a")
    expect(reg.size).toBe(1)
    expect(reg.isWithinCooldown("hook-a.ts", 60, "/repo-a")).toBeFalse()
    expect(reg.isWithinCooldown("hook-a.ts", 60, "/repo-b")).toBeTrue()
  })

  it("invalidateAll clears everything", () => {
    const reg = new CooldownRegistry()
    reg.mark("hook-a.ts", "/repo-a")
    reg.mark("hook-b.ts", "/repo-b")
    expect(reg.size).toBe(2)

    reg.invalidateAll()
    expect(reg.size).toBe(0)
  })
})

describe("GitStateCache", () => {
  it("caches git state for the current project", async () => {
    const cache = new GitStateCache()
    const result = await cache.get(process.cwd())

    expect(result).not.toBeNull()
    expect(result!.status.branch).toBeDefined()
    expect(result!.cachedAt).toBeGreaterThan(0)
    expect(cache.size).toBe(1)
  })

  it("returns null for non-git directories", async () => {
    const cache = new GitStateCache()
    const dir = await mkdtemp(join(tmpdir(), "daemon-test-"))
    const result = await cache.get(dir)

    expect(result).toBeNull()
    expect(cache.size).toBe(0)
  })

  it("returns cached reference on second call", async () => {
    const cache = new GitStateCache()
    const r1 = await cache.get(process.cwd())
    const r2 = await cache.get(process.cwd())

    expect(r1).toBe(r2) // same reference — cached
  })

  it("invalidateProject flushes only matching entries", async () => {
    const cache = new GitStateCache()
    await cache.get(process.cwd())
    // Add a second entry by calling get on a different path
    // (will be null for non-git dir, so size stays 1)
    expect(cache.size).toBe(1)

    cache.invalidateProject(process.cwd())
    expect(cache.size).toBe(0)
  })

  it("invalidateAll clears everything", async () => {
    const cache = new GitStateCache()
    await cache.get(process.cwd())
    expect(cache.size).toBe(1)

    cache.invalidateAll()
    expect(cache.size).toBe(0)
  })
})

describe("ProjectSettingsCache", () => {
  it("caches project settings for a directory", async () => {
    const cache = new ProjectSettingsCache()
    const result = await cache.get(process.cwd())

    expect(result).not.toBeNull()
    expect(result.cachedAt).toBeGreaterThan(0)
    expect(cache.size).toBe(1)
  })

  it("returns null settings for directory without .swiz/config.json", async () => {
    const cache = new ProjectSettingsCache()
    const dir = await mkdtemp(join(tmpdir(), "daemon-test-"))
    const result = await cache.get(dir)

    expect(result.settings).toBeNull()
    expect(result.resolvedHooks).toEqual([])
    expect(result.warnings).toEqual([])
    expect(cache.size).toBe(1)
  })

  it("returns cached reference on second call", async () => {
    const cache = new ProjectSettingsCache()
    const r1 = await cache.get(process.cwd())
    const r2 = await cache.get(process.cwd())

    expect(r1).toBe(r2) // same reference — cached
  })

  it("caches different projects independently", async () => {
    const cache = new ProjectSettingsCache()
    const dir = await mkdtemp(join(tmpdir(), "daemon-test-"))
    await cache.get(process.cwd())
    await cache.get(dir)
    expect(cache.size).toBe(2)
  })

  it("invalidateProject flushes only matching entries", async () => {
    const cache = new ProjectSettingsCache()
    const dir = await mkdtemp(join(tmpdir(), "daemon-test-"))
    await cache.get(process.cwd())
    await cache.get(dir)
    expect(cache.size).toBe(2)

    cache.invalidateProject(dir)
    expect(cache.size).toBe(1)
  })

  it("invalidateAll clears everything", async () => {
    const cache = new ProjectSettingsCache()
    await cache.get(process.cwd())
    expect(cache.size).toBe(1)

    cache.invalidateAll()
    expect(cache.size).toBe(0)
  })
})

describe("ManifestCache", () => {
  it("caches combined manifest on first call and returns same on second", async () => {
    const settingsCache = new ProjectSettingsCache()
    const cache = new ManifestCache(settingsCache)
    const cwd = process.cwd()

    const first = await cache.get(cwd)
    expect(first.length).toBeGreaterThan(0)
    expect(cache.size).toBe(1)

    const second = await cache.get(cwd)
    // Should be the exact same array reference (cached)
    expect(second).toBe(first)
  })

  it("invalidateProject clears only the specified project", async () => {
    const settingsCache = new ProjectSettingsCache()
    const cache = new ManifestCache(settingsCache)
    const cwd = process.cwd()

    await cache.get(cwd)
    expect(cache.size).toBe(1)

    cache.invalidateProject("/some/other/cwd")
    expect(cache.size).toBe(1)

    cache.invalidateProject(cwd)
    expect(cache.size).toBe(0)
  })

  it("invalidateAll clears everything", async () => {
    const settingsCache = new ProjectSettingsCache()
    const cache = new ManifestCache(settingsCache)

    await cache.get(process.cwd())
    expect(cache.size).toBe(1)

    cache.invalidateAll()
    expect(cache.size).toBe(0)
  })

  it("rebuilds after invalidation", async () => {
    const settingsCache = new ProjectSettingsCache()
    const cache = new ManifestCache(settingsCache)
    const cwd = process.cwd()

    const first = await cache.get(cwd)
    cache.invalidateProject(cwd)
    const second = await cache.get(cwd)

    // New array after invalidation (not same reference)
    expect(second).not.toBe(first)
    // But same content
    expect(second.length).toBe(first.length)
  })
})

// ── Webhook support ─────────────────────────────────────────────────────────

async function makeSignature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  return `sha256=${hex}`
}

describe("verifyWebhookSignature", () => {
  const SECRET = "test-webhook-secret"
  const BODY = JSON.stringify({ action: "completed", workflow_run: { head_sha: "abc123" } })

  it("returns true for a valid HMAC-SHA256 signature", async () => {
    const sig = await makeSignature(SECRET, BODY)
    const result = await verifyWebhookSignature(SECRET, new TextEncoder().encode(BODY).buffer, sig)
    expect(result).toBeTrue()
  })

  it("returns false for a tampered body", async () => {
    const sig = await makeSignature(SECRET, BODY)
    const tampered = `${BODY} `
    const result = await verifyWebhookSignature(
      SECRET,
      new TextEncoder().encode(tampered).buffer,
      sig
    )
    expect(result).toBeFalse()
  })

  it("returns false for a wrong secret", async () => {
    const sig = await makeSignature("wrong-secret", BODY)
    const result = await verifyWebhookSignature(SECRET, new TextEncoder().encode(BODY).buffer, sig)
    expect(result).toBeFalse()
  })

  it("returns false when signature header is missing", async () => {
    const result = await verifyWebhookSignature(SECRET, new TextEncoder().encode(BODY).buffer, null)
    expect(result).toBeFalse()
  })

  it("returns false when signature header has wrong prefix", async () => {
    const sig = await makeSignature(SECRET, BODY)
    const result = await verifyWebhookSignature(
      SECRET,
      new TextEncoder().encode(BODY).buffer,
      sig.replace("sha256=", "sha1=")
    )
    expect(result).toBeFalse()
  })
})

describe("CiWatchRegistry.handleWebhookConclusion", () => {
  it("resolves an active watch and calls notify when sha matches", async () => {
    const notifications: Array<{ sha: string; conclusion: string; runId: number | null }> = []
    const registry = new CiWatchRegistry({
      pollMs: 60_000,
      timeoutMs: 300_000,
      fetchRun: async () => null,
      notify: async (w) => {
        notifications.push({ sha: w.sha, conclusion: w.conclusion, runId: w.runId })
      },
    })

    registry.start("/repo", "deadbeef")
    expect(registry.listActive()).toHaveLength(1)

    const resolved = await registry.handleWebhookConclusion("deadbeef", "success", 42)
    expect(resolved).toBe(1)
    expect(registry.listActive()).toHaveLength(0)
    expect(notifications).toEqual([{ sha: "deadbeef", conclusion: "success", runId: 42 }])
    registry.close()
  })

  it("returns 0 and fires no notification when sha does not match", async () => {
    const notifications: string[] = []
    const registry = new CiWatchRegistry({
      pollMs: 60_000,
      timeoutMs: 300_000,
      fetchRun: async () => null,
      notify: async (w) => {
        notifications.push(w.sha)
      },
    })

    registry.start("/repo", "deadbeef")
    const resolved = await registry.handleWebhookConclusion("unknown-sha", "success", 99)
    expect(resolved).toBe(0)
    expect(registry.listActive()).toHaveLength(1)
    expect(notifications).toHaveLength(0)
    registry.close()
  })
})

describe("compliance daemon routes", () => {
  type ComplianceStore = CappedMap<
    string,
    {
      current: {
        state: string
        at: number
        taskDurations?: Array<{ id: string; status: string; durationMs: number }>
      } | null
      transitions: {
        state: string
        at: number
        taskDurations?: Array<{ id: string; status: string; durationMs: number }>
      }[]
    }
  >

  function makeStore(): ComplianceStore {
    return new CappedMap(100)
  }

  it("resolveComplianceDurationLabel returns null for unknown session", () => {
    const store = makeStore()
    expect(resolveComplianceDurationLabel("unknown-session", store)).toBeNull()
  })

  it("resolveComplianceDurationLabel returns null when current is null", () => {
    const store = makeStore()
    store.set("sess1", { current: null, transitions: [] })
    expect(resolveComplianceDurationLabel("sess1", store)).toBeNull()
  })

  it("resolveComplianceDurationLabel returns seconds label for recent entry", () => {
    const store = makeStore()
    store.set("sess1", { current: { state: "healthy", at: Date.now() - 30_000 }, transitions: [] })
    const label = resolveComplianceDurationLabel("sess1", store)
    expect(label).toMatch(/^\d+s$/)
  })

  it("resolveComplianceDurationLabel returns minutes label for older entry", () => {
    const store = makeStore()
    store.set("sess1", {
      current: { state: "unhealthy", at: Date.now() - 3 * 60_000 },
      transitions: [],
    })
    const label = resolveComplianceDurationLabel("sess1", store)
    expect(label).toMatch(/^\d+m$/)
  })

  it("resolveComplianceDurationLabel returns hours label for very old entry", () => {
    const store = makeStore()
    store.set("sess1", {
      current: { state: "healthy", at: Date.now() - 2 * 60 * 60_000 },
      transitions: [],
    })
    const label = resolveComplianceDurationLabel("sess1", store)
    expect(label).toMatch(/^\d+h$/)
  })

  it("stores task activity durations on compliance entry", () => {
    const store = makeStore()
    const taskDurations = [
      { id: "1", status: "in_progress", durationMs: 600_000 },
      { id: "2", status: "pending", durationMs: 120_000 },
    ]
    store.set("sess1", {
      current: { state: "unhealthy", at: Date.now() - 60_000, taskDurations },
      transitions: [{ state: "unhealthy", at: Date.now() - 60_000, taskDurations }],
    })
    const entry = store.get("sess1")
    expect(entry?.current?.taskDurations).toHaveLength(2)
    expect(entry?.current?.taskDurations?.[0]).toMatchObject({
      id: "1",
      status: "in_progress",
      durationMs: 600_000,
    })
  })

  it("duration label is independent of taskDurations payload", () => {
    const store = makeStore()
    store.set("sess1", {
      current: {
        state: "unhealthy",
        at: Date.now() - 90_000,
        taskDurations: [{ id: "1", status: "in_progress", durationMs: 90_000 }],
      },
      transitions: [],
    })
    expect(resolveComplianceDurationLabel("sess1", store)).toMatch(/^1m$/)
  })
})
