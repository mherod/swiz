import { describe, expect, it } from "bun:test"
import {
  createMetrics,
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
