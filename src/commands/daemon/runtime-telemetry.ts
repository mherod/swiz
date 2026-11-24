/**
 * Runtime telemetry for the daemon process itself.
 *
 * Hook durations alone cannot distinguish "this hook is slow" from "the
 * daemon's single JavaScript thread was busy, so everything waited". These
 * signals measure the thread directly:
 *
 * - event-loop lag: how late a fixed-interval timer fires. Lag is time during
 *   which no dispatch, hook, or timeout could run.
 * - CPU share: how much of each window the process spent on CPU.
 * - on-demand JS profile: which functions the thread was running.
 */

import { profile } from "bun:jsc"

const LAG_SAMPLE_INTERVAL_MS = 100
/** Five minutes of samples at the interval above. */
const LAG_WINDOW_SAMPLES = 3_000
const CPU_SAMPLE_INTERVAL_MS = 5_000
const STALL_THRESHOLD_MS = 200
const LONG_STALL_THRESHOLD_MS = 1_000
const MAX_RECORDED_STALLS = 20
export const MAX_PROFILE_SECONDS = 30
const PROFILE_SAMPLE_INTERVAL_US = 1_000

export interface EventLoopStall {
  at: string
  lagMs: number
}

export interface RuntimeTelemetrySnapshot {
  eventLoop: {
    sampleIntervalMs: number
    windowSamples: number
    p50Ms: number
    p95Ms: number
    p99Ms: number
    maxMs: number
    /** Share of the window during which the loop was blocked (0–100). */
    blockedPct: number
    stallsOver200Ms: number
    stallsOver1s: number
    /** Lifetime totals since the daemon started. */
    lifetimeStallsOver200Ms: number
    lifetimeStalledMs: number
    recentStalls: EventLoopStall[]
  }
  cpu: {
    windowMs: number
    userPct: number
    systemPct: number
    totalPct: number
    lifetimeCpuSeconds: number
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}

const round = (value: number): number => Math.round(value * 10) / 10

/** Ring buffer of loop-lag samples plus lifetime stall counters. */
export class EventLoopLagRecorder {
  private readonly samples: number[] = []
  private cursor = 0
  private lifetimeStalls = 0
  private lifetimeStalledMs = 0
  private readonly stalls: EventLoopStall[] = []

  constructor(
    private readonly capacity = LAG_WINDOW_SAMPLES,
    private readonly intervalMs = LAG_SAMPLE_INTERVAL_MS
  ) {}

  record(lagMs: number, now = Date.now()): void {
    const lag = Math.max(0, lagMs)
    if (this.samples.length < this.capacity) this.samples.push(lag)
    else this.samples[this.cursor] = lag
    this.cursor = (this.cursor + 1) % this.capacity
    if (lag < STALL_THRESHOLD_MS) return
    this.lifetimeStalls += 1
    this.lifetimeStalledMs += lag
    this.stalls.push({ at: new Date(now).toISOString(), lagMs: Math.round(lag) })
    if (this.stalls.length > MAX_RECORDED_STALLS) this.stalls.shift()
  }

  snapshot(): RuntimeTelemetrySnapshot["eventLoop"] {
    const sorted = [...this.samples].sort((a, b) => a - b)
    const blockedMs = sorted.reduce((sum, lag) => sum + lag, 0)
    // Each sample covers its interval plus however long the timer was delayed.
    const windowMs = sorted.length * this.intervalMs + blockedMs
    return {
      sampleIntervalMs: this.intervalMs,
      windowSamples: sorted.length,
      p50Ms: round(percentile(sorted, 50)),
      p95Ms: round(percentile(sorted, 95)),
      p99Ms: round(percentile(sorted, 99)),
      maxMs: round(sorted.at(-1) ?? 0),
      blockedPct: windowMs === 0 ? 0 : round((blockedMs / windowMs) * 100),
      stallsOver200Ms: sorted.filter((lag) => lag >= STALL_THRESHOLD_MS).length,
      stallsOver1s: sorted.filter((lag) => lag >= LONG_STALL_THRESHOLD_MS).length,
      lifetimeStallsOver200Ms: this.lifetimeStalls,
      lifetimeStalledMs: Math.round(this.lifetimeStalledMs),
      recentStalls: [...this.stalls],
    }
  }
}

interface RuntimeTelemetryState {
  lag: EventLoopLagRecorder
  cpu: RuntimeTelemetrySnapshot["cpu"]
}

let state: RuntimeTelemetryState | null = null
let profileInFlight = false

const EMPTY_CPU: RuntimeTelemetrySnapshot["cpu"] = {
  windowMs: 0,
  userPct: 0,
  systemPct: 0,
  totalPct: 0,
  lifetimeCpuSeconds: 0,
}

/** Start sampling. Returns a stop function. Timers are unref'd so they never hold the process open. */
export function startRuntimeTelemetry(): () => void {
  const current: RuntimeTelemetryState = { lag: new EventLoopLagRecorder(), cpu: { ...EMPTY_CPU } }
  state = current

  let expected = performance.now() + LAG_SAMPLE_INTERVAL_MS
  const lagTimer = setInterval(() => {
    const now = performance.now()
    current.lag.record(now - expected)
    expected = now + LAG_SAMPLE_INTERVAL_MS
  }, LAG_SAMPLE_INTERVAL_MS)
  lagTimer.unref()

  let previousUsage = process.cpuUsage()
  let previousAt = performance.now()
  const cpuTimer = setInterval(() => {
    const usage = process.cpuUsage()
    const now = performance.now()
    const windowMs = now - previousAt
    const userMs = (usage.user - previousUsage.user) / 1000
    const systemMs = (usage.system - previousUsage.system) / 1000
    current.cpu = {
      windowMs: Math.round(windowMs),
      userPct: round((userMs / windowMs) * 100),
      systemPct: round((systemMs / windowMs) * 100),
      totalPct: round(((userMs + systemMs) / windowMs) * 100),
      lifetimeCpuSeconds: Math.round((usage.user + usage.system) / 1_000_000),
    }
    previousUsage = usage
    previousAt = now
  }, CPU_SAMPLE_INTERVAL_MS)
  cpuTimer.unref()

  return () => {
    clearInterval(lagTimer)
    clearInterval(cpuTimer)
    if (state === current) state = null
  }
}

/** Current runtime telemetry, or null when sampling has not been started. */
export function getRuntimeTelemetry(): RuntimeTelemetrySnapshot | null {
  if (!state) return null
  return { eventLoop: state.lag.snapshot(), cpu: { ...state.cpu } }
}

export interface CpuProfileResult {
  seconds: number
  functions: string
  bytecodes: string
  stackTraces: string[]
}

/**
 * Sample the daemon's JavaScript thread for `seconds` and report the hottest
 * functions. One profile at a time: overlapping samplers would distort each other.
 */
export async function captureCpuProfile(seconds: number): Promise<CpuProfileResult | null> {
  if (profileInFlight) return null
  const bounded = Math.min(MAX_PROFILE_SECONDS, Math.max(1, Math.round(seconds) || 1))
  profileInFlight = true
  try {
    const result = await profile(() => Bun.sleep(bounded * 1000), PROFILE_SAMPLE_INTERVAL_US)
    // bun-types declares string[], but the runtime has returned a single string.
    const rawTraces: unknown = result.stackTraces
    const stackTraces = Array.isArray(rawTraces)
      ? rawTraces.map(String)
      : String(rawTraces ?? "")
          .split(/\n\s*\n/)
          .filter((trace) => trace.trim().length > 0)
    return {
      seconds: bounded,
      functions: String(result.functions ?? ""),
      bytecodes: String(result.bytecodes ?? ""),
      stackTraces,
    }
  } finally {
    profileInFlight = false
  }
}

/** `GET /debug/cpu-profile?seconds=10` — plain-text summary of where the thread spent its time. */
export async function handleCpuProfileRoute(url: URL): Promise<Response> {
  const seconds = Number.parseInt(url.searchParams.get("seconds") ?? "10", 10)
  const result = await captureCpuProfile(seconds)
  if (!result) return new Response("A profile is already running.\n", { status: 409 })
  const traces = Number.parseInt(url.searchParams.get("traces") ?? "15", 10)
  const body = [
    `Profiled ${result.seconds}s`,
    result.functions,
    result.bytecodes.split("\n\n")[0] ?? "",
    "Stack traces of the hottest functions:",
    ...result.stackTraces.slice(0, Math.max(0, traces)),
  ].join("\n\n")
  return new Response(`${body}\n`, { headers: { "content-type": "text/plain; charset=utf-8" } })
}
