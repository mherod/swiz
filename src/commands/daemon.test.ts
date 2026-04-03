import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LRUCache } from "lru-cache"
import type { Session } from "../transcript-utils.ts"
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
import { hasSnapshotInvalidated } from "./daemon/snapshot.ts"
import type { CapturedToolCall } from "./daemon/utils.ts"
import { DaemonWorkerRuntime } from "./daemon/worker-runtime.ts"
import { hydratePersistedSessionToolState } from "./daemon.ts"

describe("snapshot resolver .finally() cleanup", () => {
  it("cleans up inFlight map after successful snapshot computation", async () => {
    // Reconstruct the buildSnapshotResolver logic to test .finally() cleanup
    const snapshots: LRUCache<string, object> = new LRUCache({ max: 10 })
    const inFlight = new Map<string, Promise<object>>()

    // Mock computeWarmStatusLineSnapshot
    let computeCount = 0
    const mockCompute = async (_cwd: string, _sessionId?: string) => {
      computeCount += 1
      return {
        shortCwd: "/test",
        gitInfo: "main",
        gitBranch: "main",
        activeSegments: [],
        issueCount: null,
        prCount: null,
      }
    }

    // NOT async — returns the promise directly without wrapping
    const resolver = (cwd: string, sessionId?: string): Promise<object> => {
      const inflight = inFlight.get(cwd)
      if (inflight) return inflight

      const computation = mockCompute(cwd, sessionId)
        .then((snapshot) => {
          snapshots.set(`${cwd}\x00${sessionId ?? ""}`, snapshot)
          return snapshot
        })
        .finally(() => {
          inFlight.delete(cwd)
        })
      inFlight.set(cwd, computation)
      return computation
    }

    // First call: adds to inFlight
    const p1 = resolver("/cwd", "sess1")

    // Concurrent call should coalesce
    const p2 = resolver("/cwd", "sess1")
    expect(p1).toBe(p2)
    expect(inFlight.has("/cwd")).toBeTrue()

    // Wait for computation
    await p1
    expect(computeCount).toBe(1)

    // After completion, inFlight should be cleared by .finally()
    expect(inFlight.has("/cwd")).toBeFalse()

    // Second resolver call should trigger new computation (no coalescing)
    const p3 = resolver("/cwd", "sess1")
    expect(p3).not.toBe(p1)
    expect(inFlight.has("/cwd")).toBeTrue()

    await p3
    expect(computeCount).toBe(2)
    expect(inFlight.has("/cwd")).toBeFalse()
  })

  it("cleans up inFlight map after rejected snapshot computation", async () => {
    const snapshots: LRUCache<string, object> = new LRUCache({ max: 10 })
    const inFlight = new Map<string, Promise<object>>()

    let computeCount = 0
    const testError = new Error("test failure")
    const mockCompute = async (_cwd: string, _sessionId?: string) => {
      computeCount += 1
      throw testError
    }

    // NOT async — returns the promise directly without wrapping
    const resolver = (cwd: string, sessionId?: string): Promise<object> => {
      const inflight = inFlight.get(cwd)
      if (inflight) return inflight

      const computation = mockCompute(cwd, sessionId)
        .then((snapshot) => {
          snapshots.set(`${cwd}\x00${sessionId ?? ""}`, snapshot)
          return snapshot
        })
        .catch((err) => {
          // Re-throw after .finally() runs to ensure inFlight cleanup happens
          throw err
        })
        .finally(() => {
          inFlight.delete(cwd)
        })
      inFlight.set(cwd, computation)
      return computation
    }

    // First call: adds to inFlight
    const p1 = resolver("/cwd", "sess1")

    // Concurrent call should coalesce on same (rejected) promise
    const p2 = resolver("/cwd", "sess1")
    expect(p1).toBe(p2)
    expect(inFlight.has("/cwd")).toBeTrue()

    // Wait for rejection
    try {
      await p1
    } catch (e) {
      expect(e).toBe(testError)
    }
    expect(computeCount).toBe(1)

    // After rejection, .finally() should still clean up inFlight
    expect(inFlight.has("/cwd")).toBeFalse()

    // Second resolver call should trigger new computation (no coalescing)
    const p3 = resolver("/cwd", "sess1")
    expect(p3).not.toBe(p1)
    expect(inFlight.has("/cwd")).toBeTrue()

    try {
      await p3
    } catch (e) {
      expect(e).toBe(testError)
    }
    expect(computeCount).toBe(2)
    expect(inFlight.has("/cwd")).toBeFalse()
  })
})

describe("hasSnapshotInvalidated", () => {
  const base = {
    git: '{"branch":"main"}',
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

  it("invalidates when git state changes", () => {
    expect(hasSnapshotInvalidated(base, { ...base, git: '{"branch":"feat"}' })).toBeTrue()
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
      sessionToolUsage: new Map<
        string,
        { toolNames: string[]; skillInvocations: string[]; lastSeen: number }
      >(),
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
    })

    expect(count).toBe(1)
    expect(state.sessionToolCalls.get("session-1")).toEqual(recoveredCalls)
    expect(state.sessionToolUsage.get("session-1")).toEqual({
      toolNames: ["Read", "Skill"],
      skillInvocations: ["commit"],
      lastSeen: Date.parse("2026-04-03T10:01:00.000Z"),
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
      sessionToolUsage: new Map<
        string,
        { toolNames: string[]; skillInvocations: string[]; lastSeen: number }
      >([["session-1", { toolNames: ["Read"], skillInvocations: [], lastSeen: 10 }]]),
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
    })

    expect(count).toBe(1)
    expect(state.sessionToolCalls.get("session-1")).toEqual([
      { name: "Read", detail: "/tmp/file.ts", timestamp: "2026-04-03T10:00:00.000Z" },
      { name: "Bash", detail: "ls", timestamp: "2026-04-03T10:02:00.000Z" },
    ])
    expect(state.sessionToolUsage.get("session-1")).toEqual({
      toolNames: ["Read", "Read", "Bash"],
      skillInvocations: [],
      lastSeen: Date.parse("2026-04-03T10:02:00.000Z"),
    })
    expect(state.sessionActivity.get("session-1")).toEqual({
      lastSeen: Date.parse("2026-04-03T10:02:00.000Z"),
      dispatches: 2,
    })
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
    const reg = new FileWatcherRegistry()
    registries.push(reg)
    reg.register("/tmp", "tmp", () => {})
    await reg.start()
    expect(reg.status()[0]?.watching).toBeTrue()
    reg.close()
    expect(reg.status()[0]?.watching).toBeFalse()
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
