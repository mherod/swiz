export function createSingleFlight(task: () => Promise<void>): () => Promise<void> {
  let active: Promise<void> | null = null
  return () => {
    if (active) return active
    active = task().finally(() => {
      active = null
    })
    return active
  }
}

/** One cancellable flight per visible epoch; resuming never waits for an obsolete request. */
export function startVisiblePolling(
  task: (signal: AbortSignal) => Promise<void>,
  intervalMs: number
): { refresh: () => Promise<void>; stop: () => void } {
  let controller: AbortController | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  let refresh: (() => Promise<void>) | undefined
  const suspend = () => {
    controller?.abort()
    controller = undefined
    if (interval !== undefined) clearInterval(interval)
    interval = undefined
    refresh = undefined
  }
  const resume = () => {
    if (document.visibilityState === "hidden") {
      suspend()
      return
    }
    if (controller) return
    controller = new AbortController()
    const { signal } = controller
    refresh = createSingleFlight(() => task(signal))
    const tick = () => void refresh?.().catch(() => {})
    tick()
    interval = setInterval(tick, intervalMs)
  }
  document.addEventListener("visibilitychange", resume)
  resume()
  return {
    refresh: () => refresh?.() ?? Promise.resolve(),
    stop: () => {
      document.removeEventListener("visibilitychange", resume)
      suspend()
    },
  }
}
