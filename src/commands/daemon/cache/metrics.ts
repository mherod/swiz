export interface EventMetrics {
  count: number
  totalMs: number
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

export interface SerializedDaemonMetrics {
  uptimeMs: number
  uptimeHuman: string
  totalDispatches: number
  byEvent: Record<string, { count: number; avgMs: number }>
  transcriptDispatch?: TranscriptDispatchMetrics
  memoryUsage?: NodeJS.MemoryUsage
}

export function createMetrics(): DaemonMetrics {
  return { startedAt: Date.now(), dispatches: new Map() }
}

export function recordDispatch(metrics: DaemonMetrics, event: string, durationMs: number): void {
  const existing = metrics.dispatches.get(event)
  if (existing) {
    existing.count += 1
    existing.totalMs += durationMs
  } else {
    metrics.dispatches.set(event, { count: 1, totalMs: durationMs })
  }
}

export function serializeMetrics(metrics: DaemonMetrics): SerializedDaemonMetrics {
  const uptimeMs = Date.now() - metrics.startedAt
  const byEvent: Record<string, { count: number; avgMs: number }> = {}
  let totalDispatches = 0
  for (const [event, m] of metrics.dispatches) {
    byEvent[event] = { count: m.count, avgMs: Math.round(m.totalMs / m.count) }
    totalDispatches += m.count
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
