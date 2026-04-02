/**
 * Scale / memory stress tests for transcript session monitoring primitives:
 * {@link CappedMap} (TranscriptMonitor fingerprint stores), {@link TranscriptDispatchConcurrencyGate},
 * and {@link sortSessionsDeterministic} (session aggregation path).
 */
import { describe, expect, test } from "bun:test"
import type { Session } from "../../../transcript-schemas.ts"
import { sortSessionsDeterministic } from "../../../transcript-sessions-discovery.ts"
import { CappedMap } from "../../../utils/capped-map.ts"
import { CooldownRegistry } from "./cooldown-registry.ts"
import { TranscriptDispatchConcurrencyGate } from "./transcript-dispatch-concurrency.ts"
import { TranscriptMonitor } from "./transcript-monitor.ts"

const INSERTS = 40_000
const CAP = 100
const SESSION_BATCH = 60_000

function maybeGc(): void {
  const bun = globalThis as { Bun?: { gc?: () => void } }
  if (typeof bun.Bun?.gc === "function") {
    bun.Bun.gc()
  }
}

function heapUsed(): number {
  return process.memoryUsage().heapUsed
}

function makeMonitor(): TranscriptMonitor {
  return new TranscriptMonitor({
    manifestCache: { get: async () => [] },
    cooldownRegistry: new CooldownRegistry(),
    projectSettingsCache: { get: async () => ({ settings: null }) },
  })
}

type MonitorFingerprints = Pick<TranscriptMonitor, "pruneOldSessions"> & {
  lastToolCallFingerprints: CappedMap<string, string>
  lastMessageFingerprints: CappedMap<string, string>
}

function asMonitorFingerprints(m: TranscriptMonitor): MonitorFingerprints {
  return m as unknown as MonitorFingerprints
}

describe("transcript session monitoring scale / memory", () => {
  test("CappedMap stays at max size; post-GC heap growth bounded while map is retained", () => {
    for (let g = 0; g < 3; g++) maybeGc()
    const before = heapUsed()
    const map = new CappedMap<string, string>(CAP)
    for (let i = 0; i < INSERTS; i++) {
      map.set(`session-${i}`, `fingerprint-${i}`)
    }
    expect(map.size).toBe(CAP)
    for (let g = 0; g < 3; g++) maybeGc()
    const after = heapUsed()
    const mu = process.memoryUsage()
    expect(mu.heapUsed).toBeGreaterThan(0)
    expect(mu.external).toBeGreaterThanOrEqual(0)
    // Only ~CAP entries remain; ceiling catches accidental unbounded retention.
    expect(after - before).toBeLessThan(56 * 1024 * 1024)
  })

  test("TranscriptMonitor fingerprint maps remain bounded under heavy churn", () => {
    const monitor = makeMonitor()
    const inner = asMonitorFingerprints(monitor)

    for (let i = 0; i < INSERTS; i++) {
      inner.lastToolCallFingerprints.set(`sess-${i}`, `tool-fp-${i}`)
      inner.lastMessageFingerprints.set(`sess-${i}`, `msg-fp-${i}`)
    }

    expect(inner.lastToolCallFingerprints.size).toBe(CAP)
    expect(inner.lastMessageFingerprints.size).toBe(CAP)
  })

  test("TranscriptMonitor pruneOldSessions drops stale fingerprint entries", () => {
    const monitor = makeMonitor()
    const inner = asMonitorFingerprints(monitor)
    for (let i = 0; i < 50; i++) {
      inner.lastToolCallFingerprints.set(`keep-${i}`, `a-${i}`)
      inner.lastMessageFingerprints.set(`keep-${i}`, `b-${i}`)
    }
    inner.lastToolCallFingerprints.set("stale-1", "x")
    inner.lastMessageFingerprints.set("stale-1", "y")

    monitor.pruneOldSessions(new Set([...Array.from({ length: 50 }, (_, i) => `keep-${i}`)]))

    expect(inner.lastToolCallFingerprints.has("stale-1")).toBe(false)
    expect(inner.lastMessageFingerprints.has("stale-1")).toBe(false)
    expect(inner.lastToolCallFingerprints.size).toBe(50)
  })

  test("TranscriptDispatchConcurrencyGate completes many schedules without unbounded queue growth", async () => {
    const gate = new TranscriptDispatchConcurrencyGate()
    gate.setMaxConcurrent(2)
    const n = 15_000
    let completed = 0

    maybeGc()
    const before = heapUsed()

    for (let i = 0; i < n; i++) {
      gate.schedule(async () => {
        await Promise.resolve()
        completed++
      })
    }

    const deadline = Date.now() + 30_000
    while (completed < n && Date.now() < deadline) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }

    expect(completed).toBe(n)

    maybeGc()
    const after = heapUsed()
    expect(after - before).toBeLessThan(64 * 1024 * 1024)
  })

  test("sortSessionsDeterministic handles a large session list in place", () => {
    const sessions: Session[] = []
    for (let i = 0; i < SESSION_BATCH; i++) {
      sessions.push({
        id: `id-${i.toString(36)}`,
        path: `/tmp/t/${i}.jsonl`,
        mtime: i % 997,
        provider: "claude",
        format: "jsonl",
      })
    }

    maybeGc()
    const before = heapUsed()
    sortSessionsDeterministic(sessions)
    const after = heapUsed()

    expect(sessions.length).toBe(SESSION_BATCH)
    expect(sessions[0]!.mtime).toBeGreaterThanOrEqual(sessions[SESSION_BATCH - 1]!.mtime)
    expect(after - before).toBeLessThan(80 * 1024 * 1024)
  })
})
