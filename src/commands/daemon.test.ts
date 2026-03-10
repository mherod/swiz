import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CooldownRegistry,
  createMetrics,
  FileWatcherRegistry,
  GhQueryCache, // daemon gh cache
  GitStateCache,
  HookEligibilityCache,
  hasSnapshotInvalidated,
  ManifestCache,
  ProjectSettingsCache,
  recordDispatch,
  serializeMetrics,
  TranscriptIndexCache,
} from "./daemon.ts"

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

  it("close stops all watchers", () => {
    const reg = new FileWatcherRegistry()
    registries.push(reg)
    reg.register("/tmp", "tmp", () => {})
    reg.start()
    expect(reg.status()[0]?.watching).toBeTrue()
    reg.close()
    expect(reg.status()[0]?.watching).toBeFalse()
  })

  it("start ignores non-existent paths gracefully", () => {
    const reg = new FileWatcherRegistry()
    registries.push(reg)
    reg.register("/nonexistent/path/that/does/not/exist", "missing", () => {})
    reg.start()
    expect(reg.status()[0]?.watching).toBeFalse()
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

  it("detects blocked tool_use IDs from ACTION REQUIRED", async () => {
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
              content: "Hook denied. ACTION REQUIRED: fix the issue.",
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
