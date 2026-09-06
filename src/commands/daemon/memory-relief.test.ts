import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearFileCache,
  getCachedFileText,
  getFileCacheMemoryStats,
} from "../../utils/file-cache.ts"
import { createMetrics } from "./cache/metrics.ts"
import { WorkerTranscriptMonitor } from "./cache/worker-transcript-monitor.ts"
import { MemoryPressureMonitor } from "./memory-pressure.ts"
import { applyDaemonMemoryPressure } from "./memory-relief.ts"
import { SessionToolCallPersistenceQueue } from "./session-tool-call-persistence.ts"
import { type DaemonWebServerContext, startDaemonWebServer } from "./web-server.ts"

test("pressure relief preserves disk data and pending durable writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swiz-memory-relief-"))
  const path = join(dir, "history.jsonl")
  const content = "private transcript 🔒"
  await Bun.write(path, content)
  clearFileCache()
  await getCachedFileText(path)
  // UTF-8 bytes, not UTF-16 code units: the emoji is 4 bytes, so this is deliberately
  // larger than `content.length` and smaller than the old `length * 2` estimate (#814).
  expect(getFileCacheMemoryStats()).toEqual({
    entries: 1,
    estimatedBytes: Buffer.byteLength(content, "utf8"),
  })
  await getCachedFileText(path)
  expect(getFileCacheMemoryStats().entries).toBe(1)
  let finish!: () => void
  let persisted = false
  const queue = new SessionToolCallPersistenceQueue(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    persisted = true
  })
  queue.enqueue({ cwd: dir, sessionId: "test-session", toolName: "Read", toolInput: {}, nowMs: 0 })
  const snapshots = new Map([["private key", "private content"]])
  const index = new Map([["private key", "private content"]])
  const pauses: boolean[] = []
  const resources = {
    snapshots,
    transcriptIndex: { invalidateAll: () => index.clear() },
    transcriptMonitor: { setMemoryPressure: (paused: boolean) => pauses.push(paused) },
  }
  applyDaemonMemoryPressure(true, resources)
  expect(getFileCacheMemoryStats()).toEqual({ entries: 0, estimatedBytes: 0 })
  expect(snapshots.size).toBe(0)
  expect(index.size).toBe(0)
  expect(queue.pendingCount()).toBe(1)
  expect(await Bun.file(path).text()).toBe(content)
  finish()
  await queue.flush()
  expect(persisted).toBe(true)
  applyDaemonMemoryPressure(false, resources)
  expect(pauses).toEqual([true, false])
  expect(await getCachedFileText(path)).toBe(content)
  clearFileCache()
  await Bun.file(path).delete()
})

test("health and memory HTTP routes bypass expensive pruning during pressure", async () => {
  const metrics = createMetrics()
  const monitor = new MemoryPressureMonitor(
    { highBytes: 100, lowBytes: 50, confirmations: 1, cooldownMs: 10, intervalMs: 30_000 },
    () => {}
  )
  metrics.memoryPressure = monitor.snapshot
  monitor.sample({ rss: 200, heapUsed: 20, heapTotal: 30, external: 5, arrayBuffers: 0 }, null, 0)
  const ctx = {
    port: 0,
    globalMetrics: metrics,
    pruneTranscriptMemory: () => {
      throw new Error("must not run on a lightweight route")
    },
  } as unknown as DaemonWebServerContext
  const server = startDaemonWebServer(ctx)
  try {
    const health = await fetch(new URL("/health", server.url), {
      signal: AbortSignal.timeout(1000),
    })
    expect(await health.text()).toBe("ok")
    const response = await fetch(new URL("/memory", server.url), {
      signal: AbortSignal.timeout(1000),
    })
    const body = await response.json()
    expect(body.pressure.state).toBe("degraded")
    expect(body.pressure.heapUsed).toBe(20)
    expect(body.runtime).toBeNull()
    expect(response.headers.get("cache-control")).toBe("no-store")
    const history = await fetch(new URL("/sessions/messages", server.url), { method: "POST" })
    expect(history.status).toBe(503)
  } finally {
    await server.stop(true)
  }
})

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000
  while (!check() && Date.now() < deadline) await Bun.sleep(10)
  expect(check()).toBe(true)
}

test("real transcript worker publishes content-free memory and acknowledges pressure", async () => {
  let settingsReads = 0
  const worker = new WorkerTranscriptMonitor({
    manifestCache: { get: async () => [] },
    projectSettingsCache: {
      get: async () => {
        settingsReads++
        return { settings: null }
      },
    },
    cooldownRegistry: { checkAndMark: () => false },
  })
  try {
    await waitFor(() => worker.getMemorySnapshot() !== null)
    worker.setMemoryPressure(true)
    await waitFor(() => worker.getMemorySnapshot()?.degraded === true)
    await worker.checkProject("/private-project-not-to-be-read")
    expect(settingsReads).toBe(0)
    const snapshot = worker.getMemorySnapshot()!
    expect(snapshot.activeChecks).toBe(0)
    expect(snapshot.pendingRequests).toBe(0)
    expect(snapshot.heapUsed).toBeGreaterThan(0)
    expect(snapshot.fileCacheEntries).toBe(0)
    expect(JSON.stringify(snapshot)).not.toContain("private-project")
    expect(
      Object.values(snapshot).every(
        (value) => typeof value === "number" || typeof value === "boolean"
      )
    ).toBe(true)
    expect(worker.getMemorySnapshot(snapshot.sampledAt + 90_001)).toBeNull()
    worker.setMemoryPressure(false)
    await waitFor(() => worker.getMemorySnapshot()?.degraded === false)
  } finally {
    worker.terminate()
  }
})
