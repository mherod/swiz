import { spawnWithTimeout } from "../../utils/process-utils.ts"
import type { DaemonMetrics } from "./cache/metrics.ts"

export interface MemoryPressureConfig {
  highBytes: number
  lowBytes: number
  confirmations: number
  cooldownMs: number
  intervalMs: number
}

export interface WorkerMemorySnapshot {
  sampledAt: number
  degraded: boolean
  heapUsed: number
  external: number
  arrayBuffers: number
  activeChecks: number
  pendingRequests: number
  rpcTimeouts?: number
  rpcFailures?: number
  activeDispatches: number
  queuedDispatches: number
  fileCacheEntries: number
  fileCacheEstimatedBytes: number
}

export interface MemoryPressureSnapshot {
  state: "normal" | "degraded"
  sampledAt: number | null
  rss: number
  osRssBytes: number | null
  effectiveRssBytes: number
  rssHighWaterBytes: number
  heapUsed: number
  external: number
  arrayBuffers: number
  highSamples: number
  lowSamples: number
  pressureEvents: number
  lastPressureAt: number | null
  actionErrors: number
  samplingErrors: number
  config: MemoryPressureConfig
}

/** Numeric environment configuration is read once at daemon startup. */
export function memoryPressureConfig(env: NodeJS.ProcessEnv = process.env): MemoryPressureConfig {
  const number = (key: string, fallback: number): number => {
    const value = env[key] === undefined ? fallback : Number(env[key])
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${key}`)
    return value
  }
  const highBytes = number("SWIZ_DAEMON_MEMORY_LIMIT_MB", 4096) * 1024 ** 2
  const lowBytes = number("SWIZ_DAEMON_MEMORY_RESUME_MB", 3072) * 1024 ** 2
  if (![highBytes, lowBytes].every(Number.isSafeInteger))
    throw new Error("Daemon memory limit is too large")
  if (lowBytes >= highBytes) throw new Error("Daemon memory resume limit must be below limit")
  const intervalMs = number("SWIZ_DAEMON_MEMORY_INTERVAL_MS", 30_000)
  if (intervalMs < 1_000 || intervalMs > 2_147_483_647)
    throw new Error("Invalid daemon memory sample interval")
  return {
    highBytes,
    lowBytes,
    confirmations: number("SWIZ_DAEMON_MEMORY_CONFIRMATIONS", 3),
    cooldownMs: number("SWIZ_DAEMON_MEMORY_COOLDOWN_MS", 300_000),
    intervalMs,
  }
}

export async function readOsRss(run = spawnWithTimeout, pid = process.pid): Promise<number | null> {
  try {
    const result = await run(["ps", "-o", "rss=", "-p", String(pid)], { timeoutMs: 1_000 })
    if (result.timedOut || result.exitCode !== 0 || !/^\s*\d+\s*$/.test(result.stdout)) return null
    const bytes = Number(result.stdout.trim()) * 1024
    return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null
  } catch {
    return null
  }
}

/** One bounded state machine; no contents, paths, session identifiers or sample history. */
export class MemoryPressureMonitor {
  readonly snapshot: MemoryPressureSnapshot
  private osRequiredForRecovery = false

  constructor(
    config: MemoryPressureConfig,
    private readonly setDegraded: (degraded: boolean) => void
  ) {
    this.snapshot = {
      state: "normal",
      sampledAt: null,
      rss: 0,
      osRssBytes: null,
      effectiveRssBytes: 0,
      rssHighWaterBytes: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0,
      highSamples: 0,
      lowSamples: 0,
      pressureEvents: 0,
      lastPressureAt: null,
      actionErrors: 0,
      samplingErrors: 0,
      config,
    }
  }

  sample(memory: NodeJS.MemoryUsage, osRssBytes: number | null, now: number): void {
    if (!this.recordSample(memory, osRssBytes, now)) return
    const s = this.snapshot
    if (s.state === "normal") this.checkPressure(now)
    else this.checkRecovery(now)
  }

  private recordSample(
    memory: NodeJS.MemoryUsage,
    osRssBytes: number | null,
    now: number
  ): boolean {
    const s = this.snapshot
    if (
      ![memory.rss, memory.heapUsed, memory.external, memory.arrayBuffers, now].every(
        (n) => Number.isFinite(n) && n >= 0
      )
    ) {
      s.samplingErrors++
      s.highSamples = 0
      s.lowSamples = 0
      return false
    }
    const osRss =
      osRssBytes !== null && Number.isFinite(osRssBytes) && osRssBytes > 0 ? osRssBytes : null
    const rss = Math.max(memory.rss, osRss ?? 0)
    Object.assign(s, {
      sampledAt: now,
      rss: memory.rss,
      osRssBytes: osRss,
      effectiveRssBytes: rss,
      rssHighWaterBytes: Math.max(s.rssHighWaterBytes, rss),
      heapUsed: memory.heapUsed,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
    })
    return true
  }

  private checkPressure(now: number): void {
    const s = this.snapshot
    s.highSamples =
      s.effectiveRssBytes >= s.config.highBytes
        ? Math.min(s.config.confirmations, s.highSamples + 1)
        : 0
    if (s.highSamples < s.config.confirmations) return
    this.osRequiredForRecovery = s.osRssBytes !== null
    s.state = "degraded"
    s.pressureEvents++
    s.lastPressureAt = now
    this.transition(true)
  }

  private checkRecovery(now: number): void {
    const s = this.snapshot
    this.osRequiredForRecovery ||= s.osRssBytes !== null
    const trustworthy = !this.osRequiredForRecovery || s.osRssBytes !== null
    s.lowSamples =
      trustworthy && s.effectiveRssBytes <= s.config.lowBytes
        ? Math.min(s.config.confirmations, s.lowSamples + 1)
        : 0
    if (
      s.lowSamples < s.config.confirmations ||
      now - (s.lastPressureAt ?? now) < s.config.cooldownMs
    )
      return
    try {
      this.setDegraded(false)
      s.state = "normal"
      s.highSamples = 0
      s.lowSamples = 0
    } catch {
      s.actionErrors++
    }
  }

  private transition(degraded: boolean): void {
    try {
      this.setDegraded(degraded)
    } catch {
      this.snapshot.actionErrors++
    }
  }
}

export interface MemoryMonitoringHandle {
  monitor: MemoryPressureMonitor
  tick(): Promise<void>
  stop(): void
}

/** Singleflight sampling never waits in a request handler or on a worker RPC. */
export function startMemoryMonitoring(
  metrics: DaemonMetrics,
  setDegraded: (degraded: boolean) => void,
  config = memoryPressureConfig(),
  dependencies = { memory: () => process.memoryUsage(), osRss: readOsRss, now: Date.now }
): MemoryMonitoringHandle {
  const monitor = new MemoryPressureMonitor(config, setDegraded)
  metrics.memoryPressure = monitor.snapshot
  let sampling = false
  let stopped = false
  const tick = async () => {
    if (sampling || stopped) return
    sampling = true
    try {
      const osRss = await dependencies.osRss()
      if (stopped) return
      const memory = dependencies.memory()
      metrics.memoryUsage = memory
      monitor.sample(memory, osRss, dependencies.now())
    } catch {
      monitor.snapshot.samplingErrors++
      monitor.snapshot.highSamples = 0
      monitor.snapshot.lowSamples = 0
    } finally {
      sampling = false
    }
  }
  const timer = setInterval(() => void tick(), config.intervalMs)
  timer.unref()
  void tick()
  return {
    monitor,
    tick,
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}

/** These read-only endpoints allocate transcript history or build large snapshots. */
const PRESSURE_READ_PATHS = new Set([
  "/sessions/projects",
  "/sessions/messages",
  "/transcript/index",
  "/status-line/snapshot",
])

export function memoryPressureResponse(path: string, metrics: DaemonMetrics): Response | null {
  if (path === "/memory") {
    return Response.json(
      { pressure: metrics.memoryPressure ?? null, runtime: metrics.memoryRuntime ?? null },
      {
        headers: { "cache-control": "no-store" },
      }
    )
  }
  if (metrics.memoryPressure?.state !== "degraded" || !PRESSURE_READ_PATHS.has(path)) return null
  return Response.json(
    { error: "Daemon memory pressure: history reads are temporarily paused" },
    {
      status: 503,
      headers: { "retry-after": "30" },
    }
  )
}

export interface MemoryRuntimeSnapshot {
  sampledAt: number
  fileCacheEntries: number
  fileCacheEstimatedBytes: number
  sessionCacheEntries: number
  sessionCacheEstimatedBytes: number
  transcriptIndexEntries: number
  snapshotEntries: number
  activeHookDispatches: number
  pendingPersistenceWrites: number
  transcriptWorker: WorkerMemorySnapshot | null
  otherWorkerMemory: null
}
