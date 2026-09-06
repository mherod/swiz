import type { DaemonMetrics } from "./cache/metrics.ts"
import type { TranscriptMonitor } from "./cache/transcript-monitor.ts"

type Monitor = Pick<TranscriptMonitor, "checkProject" | "terminate"> & {
  getDispatchConcurrencyMetrics():
    | ReturnType<TranscriptMonitor["getDispatchConcurrencyMetrics"]>
    | Promise<ReturnType<TranscriptMonitor["getDispatchConcurrencyMetrics"]>>
}

/** The same tick handles timer runs and tests; every settlement releases its guard. */
export function startTranscriptMonitoring(
  projects: Set<string>,
  monitor: Monitor,
  metrics: DaemonMetrics,
  onError: (error: unknown) => void = () => {}
): { tick(): Promise<void>; isMonitoring(): boolean; stop(): void } {
  let isMonitoring = false
  let stopped = false
  const tick = async () => {
    if (isMonitoring || stopped) return
    isMonitoring = true
    try {
      await Promise.allSettled([...projects].map((cwd) => monitor.checkProject(cwd)))
      if (!stopped) {
        const dispatch = await monitor.getDispatchConcurrencyMetrics()
        if (!stopped) metrics.transcriptDispatch = dispatch
      }
    } catch (error) {
      if (!stopped) onError(error)
    } finally {
      isMonitoring = false
    }
  }
  const interval = setInterval(() => void tick(), 10_000)
  interval.unref()
  return {
    tick,
    isMonitoring: () => isMonitoring,
    stop: () => {
      stopped = true
      clearInterval(interval)
      monitor.terminate()
    },
  }
}
