import type { DispatchStageDurations } from "../../../dispatch/timing.ts"

export const HISTOGRAM_BUCKET_COUNT = 86
const HISTOGRAM_UPPER_BOUNDS_MS = Array.from(
  { length: HISTOGRAM_BUCKET_COUNT - 1 },
  (_, index) => 0.25 * 2 ** (index / 4)
)

const MAX_EVENTS = 64
const MAX_ROUTES_PER_EVENT = 16
const MAX_STAGES_PER_ROUTE = 16
const OVERFLOW_KEY = "other"

export type DispatchOutcome = "success" | "error" | "timeout"

export interface DistributionMetrics {
  count: number
  totalMs: number
  minMs: number
  maxMs: number
  buckets: number[]
  errorCount: number
  timeoutCount: number
  totalHookCount: number
  maxHookCount: number
}

export interface RouteMetrics extends DistributionMetrics {
  stages: Map<string, DistributionMetrics>
}

export interface EventMetrics extends DistributionMetrics {
  routes: Map<string, RouteMetrics>
}

export interface TranscriptDispatchMetrics {
  active: number
  queued: number
  maxConcurrent: number
}

export interface DaemonMetrics {
  startedAt: number
  dispatches: Map<string, EventMetrics>
  transcriptDispatch?: TranscriptDispatchMetrics
  memoryUsage?: NodeJS.MemoryUsage
}

export interface SerializedDistributionMetrics {
  count: number
  avgMs: number
  minMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  errorCount: number
  timeoutCount: number
  avgHookCount: number
  maxHookCount: number
}

export interface SerializedRouteMetrics extends SerializedDistributionMetrics {
  stages: Record<string, SerializedDistributionMetrics>
}

export interface SerializedEventMetrics extends SerializedDistributionMetrics {
  routes: Record<string, SerializedRouteMetrics>
}

export interface SerializedDaemonMetrics {
  uptimeMs: number
  uptimeHuman: string
  totalDispatches: number
  byEvent: Record<string, SerializedEventMetrics>
  transcriptDispatch?: TranscriptDispatchMetrics
  memoryUsage?: NodeJS.MemoryUsage
}

export interface RecordDispatchOptions {
  route?: string
  outcome?: DispatchOutcome
  stages?: DispatchStageDurations
  hookCount?: number
}

export function createMetrics(): DaemonMetrics {
  return { startedAt: Date.now(), dispatches: new Map() }
}

function createDistribution(): DistributionMetrics {
  return {
    count: 0,
    totalMs: 0,
    minMs: Number.POSITIVE_INFINITY,
    maxMs: 0,
    buckets: Array.from({ length: HISTOGRAM_UPPER_BOUNDS_MS.length + 1 }, () => 0),
    errorCount: 0,
    timeoutCount: 0,
    totalHookCount: 0,
    maxHookCount: 0,
  }
}

function createRouteMetrics(): RouteMetrics {
  return { ...createDistribution(), stages: new Map() }
}

function createEventMetrics(): EventMetrics {
  return { ...createDistribution(), routes: new Map() }
}

function boundedKey<T>(map: Map<string, T>, requested: string, limit: number): string {
  if (map.has(requested) || requested === OVERFLOW_KEY || map.size < limit - 1) return requested
  return OVERFLOW_KEY
}

function getOrCreate<T>(map: Map<string, T>, key: string, create: () => T): T {
  const existing = map.get(key)
  if (existing) return existing
  const value = create()
  map.set(key, value)
  return value
}

function recordDistribution(
  metrics: DistributionMetrics,
  durationMs: number,
  outcome: DispatchOutcome,
  hookCount: number
): void {
  const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0
  metrics.count += 1
  metrics.totalMs += duration
  metrics.minMs = Math.min(metrics.minMs, duration)
  metrics.maxMs = Math.max(metrics.maxMs, duration)
  metrics.totalHookCount += hookCount
  metrics.maxHookCount = Math.max(metrics.maxHookCount, hookCount)
  if (outcome === "error") metrics.errorCount += 1
  if (outcome === "timeout") metrics.timeoutCount += 1

  let low = 0
  let high = HISTOGRAM_UPPER_BOUNDS_MS.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (duration <= (HISTOGRAM_UPPER_BOUNDS_MS[middle] ?? Number.POSITIVE_INFINITY)) high = middle
    else low = middle + 1
  }
  const index = low
  metrics.buckets[index] = (metrics.buckets[index] ?? 0) + 1
}

export function recordDispatch(
  metrics: DaemonMetrics,
  event: string,
  durationMs: number,
  options: RecordDispatchOptions = {}
): void {
  const eventKey = boundedKey(metrics.dispatches, event, MAX_EVENTS)
  const eventMetrics = getOrCreate(metrics.dispatches, eventKey, createEventMetrics)
  const routeKey = boundedKey(eventMetrics.routes, options.route ?? "unknown", MAX_ROUTES_PER_EVENT)
  const routeMetrics = getOrCreate(eventMetrics.routes, routeKey, createRouteMetrics)
  const outcome = options.outcome ?? "success"
  const hookCount = Math.max(0, Math.trunc(options.hookCount ?? 0))

  recordDistribution(eventMetrics, durationMs, outcome, hookCount)
  recordDistribution(routeMetrics, durationMs, outcome, hookCount)

  for (const [stage, stageDurationMs] of Object.entries(options.stages ?? {})) {
    if (typeof stageDurationMs !== "number") continue
    const stageKey = boundedKey(routeMetrics.stages, stage, MAX_STAGES_PER_ROUTE)
    const stageMetrics = getOrCreate(routeMetrics.stages, stageKey, createDistribution)
    recordDistribution(stageMetrics, stageDurationMs, outcome, hookCount)
  }
}

function roundMetric(value: number): number {
  return Number(value.toFixed(2))
}

function percentile(metrics: DistributionMetrics, fraction: number): number {
  if (metrics.count === 0) return 0
  const target = Math.ceil(metrics.count * fraction)
  let cumulative = 0
  for (let index = 0; index < metrics.buckets.length; index++) {
    cumulative += metrics.buckets[index] ?? 0
    if (cumulative < target) continue
    const bound = HISTOGRAM_UPPER_BOUNDS_MS[index]
    return roundMetric(bound ?? metrics.maxMs)
  }
  return roundMetric(metrics.maxMs)
}

function serializeDistribution(metrics: DistributionMetrics): SerializedDistributionMetrics {
  return {
    count: metrics.count,
    avgMs: metrics.count === 0 ? 0 : Math.round(metrics.totalMs / metrics.count),
    minMs: metrics.count === 0 ? 0 : roundMetric(metrics.minMs),
    p50Ms: percentile(metrics, 0.5),
    p95Ms: percentile(metrics, 0.95),
    p99Ms: percentile(metrics, 0.99),
    maxMs: roundMetric(metrics.maxMs),
    errorCount: metrics.errorCount,
    timeoutCount: metrics.timeoutCount,
    avgHookCount: metrics.count === 0 ? 0 : roundMetric(metrics.totalHookCount / metrics.count),
    maxHookCount: metrics.maxHookCount,
  }
}

export function serializeMetrics(metrics: DaemonMetrics): SerializedDaemonMetrics {
  const uptimeMs = Date.now() - metrics.startedAt
  const byEvent: Record<string, SerializedEventMetrics> = {}
  let totalDispatches = 0
  for (const [event, eventMetrics] of metrics.dispatches) {
    const routes: Record<string, SerializedRouteMetrics> = {}
    for (const [route, routeMetrics] of eventMetrics.routes) {
      const stages: Record<string, SerializedDistributionMetrics> = {}
      for (const [stage, stageMetrics] of routeMetrics.stages) {
        stages[stage] = serializeDistribution(stageMetrics)
      }
      routes[route] = { ...serializeDistribution(routeMetrics), stages }
    }
    byEvent[event] = { ...serializeDistribution(eventMetrics), routes }
    totalDispatches += eventMetrics.count
  }
  return {
    uptimeMs,
    uptimeHuman: formatUptime(uptimeMs),
    totalDispatches,
    byEvent,
    ...(metrics.transcriptDispatch && { transcriptDispatch: metrics.transcriptDispatch }),
    ...(metrics.memoryUsage && { memoryUsage: metrics.memoryUsage }),
  }
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m ${sec}s`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}
