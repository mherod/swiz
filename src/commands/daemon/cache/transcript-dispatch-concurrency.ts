/**
 * Optional concurrency limiter for fire-and-forget async work (e.g. daemon transcript
 * `executeDispatch` fan-out). When `maxConcurrent <= 0`, behavior matches unlimited scheduling:
 * each `schedule` runs `fn` immediately with no queueing or waiting.
 */
export class TranscriptDispatchConcurrencyGate {
  private maxConcurrent = 0
  private active = 0
  private readonly queue: Array<() => void> = []

  setMaxConcurrent(n: number): void {
    const next = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
    const prev = this.maxConcurrent
    this.maxConcurrent = next
    if (this.maxConcurrent <= 0) {
      const pending = this.queue.splice(0)
      for (const run of pending) {
        run()
      }
    } else if (this.maxConcurrent > prev) {
      this.pump()
    }
  }

  private pump(): void {
    while (this.maxConcurrent > 0 && this.active < this.maxConcurrent && this.queue.length > 0) {
      const run = this.queue.shift()
      if (run) run()
    }
  }

  /**
   * Schedule `fn` without blocking the caller. When limited, at most `maxConcurrent`
   * runs are in flight; additional schedules queue until a run completes (slot released in `finally`).
   */
  schedule<T>(fn: () => Promise<T>): void {
    if (this.maxConcurrent <= 0) {
      void fn()
      return
    }
    const run = () => {
      this.active++
      void Promise.resolve()
        .then(fn)
        .finally(() => {
          this.active--
          this.pump()
        })
    }
    if (this.active < this.maxConcurrent) {
      run()
    } else {
      this.queue.push(run)
    }
  }

  /** Read-only accessors for metrics. */
  getActive(): number {
    return this.active
  }

  getQueueDepth(): number {
    return this.queue.length
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent
  }
}
