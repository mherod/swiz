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
 * - on-demand JS profile: which functions the thread was running
 *   (`GET /debug/cpu-profile?seconds=N&traces=N`).
 * - startup profile: the same, taken automatically over the first 90 seconds of
 *   every start and kept in memory (`GET /debug/startup-profile`).
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

const UNKNOWN_PROFILE_LINE = 0xffffffff

function describeProfileFrame(frame: unknown): string {
  const { name, sourceURL, line } = (frame ?? {}) as Record<string, unknown>
  const label = typeof name === "string" && name !== "" ? name : "(anonymous)"
  const file = typeof sourceURL === "string" ? sourceURL.split("/").slice(-2).join("/") : ""
  if (!file) return label
  const at = typeof line === "number" && line < UNKNOWN_PROFILE_LINE ? `:${line}` : ""
  return `${label} (${file}${at})`
}

/**
 * Collapse sampled stacks into the most frequent call chains, innermost frame first.
 *
 * The runtime reports `{ interval, traces: [{ frames }], sources }`; the function table alone
 * names a hot built-in such as `spawnSync` without saying which swiz code called it.
 */
export function summariseStackTraces(raw: unknown, depth = 12): string[] {
  const traces = (raw as { traces?: unknown } | null)?.traces
  if (!Array.isArray(traces)) return []
  const counts = new Map<string, number>()
  for (const trace of traces) {
    const frames = (trace as { frames?: unknown } | null)?.frames
    if (!Array.isArray(frames)) continue
    const chain = frames.slice(0, depth).map(describeProfileFrame).join("\n    <- ")
    counts.set(chain, (counts.get(chain) ?? 0) + 1)
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([chain, samples]) => `${samples} samples\n    ${chain}`)
}

function normaliseStackTraces(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  if (raw !== null && typeof raw === "object") return summariseStackTraces(raw)
  return String(raw ?? "")
    .split(/\n\s*\n/)
    .filter((trace) => trace.trim().length > 0)
}

/**
 * Sample the daemon's JavaScript thread for `seconds` and report the hottest
 * functions. One profile at a time: overlapping samplers would distort each other.
 */
export async function captureCpuProfile(seconds: number): Promise<CpuProfileResult | null> {
  const bounded = Math.min(MAX_PROFILE_SECONDS, Math.max(1, Math.round(seconds) || 1))
  return await runProfile(bounded, PROFILE_SAMPLE_INTERVAL_US)
}

async function runProfile(seconds: number, intervalUs: number): Promise<CpuProfileResult | null> {
  if (profileInFlight) return null
  profileInFlight = true
  try {
    const result = await profile(() => Bun.sleep(seconds * 1000), intervalUs)
    // bun-types declares string[]; the runtime returns an object of sampled frames.
    return {
      seconds,
      functions: String(result.functions ?? ""),
      bytecodes: String(result.bytecodes ?? ""),
      stackTraces: normaliseStackTraces(result.stackTraces),
    }
  } finally {
    profileInFlight = false
  }
}

function formatProfile(result: CpuProfileResult, traces: number): string {
  const body = [
    `Profiled ${result.seconds}s`,
    result.functions,
    result.bytecodes.split("\n\n")[0] ?? "",
    "Stack traces of the hottest functions:",
    ...result.stackTraces.slice(0, Math.max(0, traces)),
  ].join("\n\n")
  return `${body}\n`
}

const PLAIN_TEXT = { "content-type": "text/plain; charset=utf-8" }

/** `GET /debug/cpu-profile?seconds=10` — plain-text summary of where the thread spent its time. */
export async function handleCpuProfileRoute(url: URL): Promise<Response> {
  const seconds = Number.parseInt(url.searchParams.get("seconds") ?? "10", 10)
  const result = await captureCpuProfile(seconds)
  if (!result) return new Response("A profile is already running.\n", { status: 409 })
  const traces = Number.parseInt(url.searchParams.get("traces") ?? "15", 10)
  return new Response(formatProfile(result, traces), { headers: PLAIN_TEXT })
}

export const STARTUP_PROFILE_SECONDS = 90
/** Coarser than the on-demand profile because this one runs on every start. */
const STARTUP_PROFILE_SAMPLE_INTERVAL_US = 5_000
const STARTUP_PROFILE_TRACES = 30

type StartupProfileState =
  | { status: "running"; startedAtMs: number; seconds: number }
  | { status: "done"; text: string }
  | { status: "failed"; reason: string }

let startupProfile: StartupProfileState | null = null

/**
 * Profile the first `seconds` of the daemon's life and keep the summary in memory.
 *
 * A restart is when the thread stalls longest, and an on-demand profile cannot be requested
 * during those stalls because the request itself waits behind them. The daemon restarts on
 * every source edit and every commit, so this is also the state hooks most often meet.
 */
export function startStartupProfile(seconds = STARTUP_PROFILE_SECONDS): void {
  if (profileInFlight) return
  startupProfile = { status: "running", startedAtMs: Date.now(), seconds }
  void runProfile(seconds, STARTUP_PROFILE_SAMPLE_INTERVAL_US).then(
    (result) => {
      startupProfile = result
        ? { status: "done", text: formatProfile(result, STARTUP_PROFILE_TRACES) }
        : { status: "failed", reason: "another profile was already running" }
    },
    (error) => {
      startupProfile = { status: "failed", reason: String(error) }
    }
  )
}

/** `GET /debug/startup-profile` — what the thread was doing while the daemon started. */
export function handleStartupProfileRoute(): Response {
  const current = startupProfile
  if (!current) return new Response("No startup profile was taken.\n", { status: 404 })
  if (current.status === "done") return new Response(current.text, { headers: PLAIN_TEXT })
  if (current.status === "failed") {
    return new Response(`Startup profile failed: ${current.reason}\n`, { status: 500 })
  }
  const remaining = Math.ceil(current.seconds - (Date.now() - current.startedAtMs) / 1000)
  return new Response(`Startup profile still running; about ${Math.max(0, remaining)}s left.\n`, {
    status: 202,
  })
}
