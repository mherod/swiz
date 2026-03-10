import { afterEach, describe, expect, it } from "bun:test"
import {
  createMetrics,
  FileWatcherRegistry,
  GhQueryCache, // daemon gh cache
  HookEligibilityCache,
  hasSnapshotInvalidated,
  recordDispatch,
  serializeMetrics,
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
