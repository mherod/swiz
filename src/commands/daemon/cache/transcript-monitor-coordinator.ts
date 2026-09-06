export interface Deferred<T = void> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

export function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export interface TranscriptMonitorCoordinatorMetrics {
  activeChecks: number
  queuedChecks: number
  coalescedTriggers: number
}

export interface TranscriptMonitorCoordinatorOptions {
  /** Maximum number of projects that can have active checks simultaneously. Default: 4. */
  maxConcurrentChecks?: number
  /** Maximum number of projects that can be waiting in the queue. Default: 64. */
  maxQueueDepth?: number
  /**
   * Function to execute a project check (e.g. via worker message passing).
   * A result flagged `skipped` means no work ran, so it contributes no telemetry sample.
   */
  executeCheck: (cwd: string) => Promise<{ durationMs: number; error?: string; skipped?: boolean }>
  /** Optional callback invoked whenever a project check actually executes. */
  onCheckCompleted?: (cwd: string, durationMs: number, outcome: "success" | "error") => void
}

interface ProjectState {
  active: boolean
  activeDeferred: Deferred<void> | null
  queued: boolean
  dirty: boolean
  trailingDeferred: Deferred<void> | null
}

/**
 * Coordinates transcript monitor checks across multiple projects.
 *
 * Guarantees:
 * 1. Singleflight per project: At most one active check runs per project.
 * 2. Trailing rerun: Invalidations received during an active check schedule at most one trailing rerun.
 * 3. Coalescing: Additional triggers during an active check with an already-scheduled trailing rerun are coalesced.
 * 4. Fair progress: Different projects share a FIFO queue, preventing a single active project's trailing reruns from starving others.
 * 5. Bounded queue: The waiting queue is bounded by `maxQueueDepth`.
 * 6. Truthful telemetry: Tracks active checks, queued checks, coalesced triggers, and actual worker execution duration.
 */
export class TranscriptMonitorCoordinator {
  private readonly maxConcurrentChecks: number
  private readonly maxQueueDepth: number
  private readonly executeCheck: (
    cwd: string
  ) => Promise<{ durationMs: number; error?: string; skipped?: boolean }>
  private readonly onCheckCompleted?: (
    cwd: string,
    durationMs: number,
    outcome: "success" | "error"
  ) => void

  private activeCount = 0
  private coalescedCount = 0
  private queue: string[] = []
  private projects = new Map<string, ProjectState>()
  private closed = false

  constructor(options: TranscriptMonitorCoordinatorOptions) {
    this.maxConcurrentChecks = Math.max(1, options.maxConcurrentChecks ?? 4)
    this.maxQueueDepth = Math.max(1, options.maxQueueDepth ?? 64)
    this.executeCheck = options.executeCheck
    this.onCheckCompleted = options.onCheckCompleted
  }

  /**
   * Request a monitor check for a project.
   * Resolves when a check that encompasses this invalidation point has completed.
   */
  async checkProject(cwd: string): Promise<void> {
    if (this.closed) {
      throw new Error("Transcript monitor coordinator is closed")
    }

    let state = this.projects.get(cwd)
    if (!state) {
      state = {
        active: false,
        activeDeferred: null,
        queued: false,
        dirty: false,
        trailingDeferred: null,
      }
      this.projects.set(cwd, state)
    }

    // Case 1: An active check is currently running for this project.
    if (state.active) {
      if (state.dirty) {
        // Trailing rerun is already scheduled; coalesce this trigger into it.
        this.coalescedCount++
        return state.trailingDeferred!.promise
      }

      // First trigger during active run; schedule trailing rerun.
      state.dirty = true
      state.trailingDeferred = createDeferred<void>()
      return state.trailingDeferred.promise
    }

    // Case 2: Project is already queued waiting to start.
    if (state.queued) {
      // It hasn't started yet, so when it runs it will see the newest state.
      this.coalescedCount++
      return state.activeDeferred!.promise
    }

    // Case 3: Project is idle.
    state.activeDeferred = createDeferred<void>()
    if (this.activeCount < this.maxConcurrentChecks) {
      void this.runProjectCheck(cwd, state)
    } else {
      if (this.queue.length >= this.maxQueueDepth) {
        const deferred = state.activeDeferred
        state.activeDeferred = null
        this.projects.delete(cwd)
        const err = new Error("Transcript monitor queue depth exceeded")
        deferred.reject(err)
        return deferred.promise
      }
      state.queued = true
      this.queue.push(cwd)
    }

    return state.activeDeferred.promise
  }

  /**
   * Current coordinator telemetry snapshot.
   */
  getMetrics(): TranscriptMonitorCoordinatorMetrics {
    return {
      activeChecks: this.activeCount,
      queuedChecks: this.queue.length,
      coalescedTriggers: this.coalescedCount,
    }
  }

  /**
   * Terminate the coordinator and reject all pending/in-flight checks.
   */
  close(reason = "Transcript monitor coordinator closed"): void {
    this.closed = true
    const error = new Error(reason)

    for (const state of this.projects.values()) {
      if (state.activeDeferred) {
        state.activeDeferred.reject(error)
        state.activeDeferred = null
      }
      if (state.trailingDeferred) {
        state.trailingDeferred.reject(error)
        state.trailingDeferred = null
      }
    }

    this.projects.clear()
    this.queue = []
    this.activeCount = 0
  }

  private async runProjectCheck(cwd: string, state: ProjectState): Promise<void> {
    this.activeCount++
    state.active = true
    state.queued = false

    const currentDeferred = state.activeDeferred!
    let durationMs = 0
    let error: string | undefined
    let skipped = false

    try {
      const result = await this.executeCheck(cwd)
      durationMs = result.durationMs
      error = result.error
      skipped = result.skipped === true
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      if (this.closed) {
        state.active = false
      } else {
        this.activeCount = Math.max(0, this.activeCount - 1)
        state.active = false
        // A skipped check ran no work; recording it would seed the histogram with 0ms samples.
        if (!skipped) {
          this.onCheckCompleted?.(cwd, durationMs, error ? "error" : "success")
        }

        if (error) {
          currentDeferred.reject(new Error(error))
        } else {
          currentDeferred.resolve()
        }

        if (state.dirty) {
          state.dirty = false
          state.activeDeferred = state.trailingDeferred
          state.trailingDeferred = null

          // Enqueue trailing rerun fairly so other waiting projects can make progress
          state.queued = true
          this.queue.push(cwd)
        } else if (!state.queued) {
          this.projects.delete(cwd)
        }

        this.drainQueue()
      }
    }
  }

  private drainQueue(): void {
    if (this.closed) return

    while (this.activeCount < this.maxConcurrentChecks && this.queue.length > 0) {
      const nextCwd = this.queue.shift()!
      const nextState = this.projects.get(nextCwd)
      if (nextState?.queued) {
        void this.runProjectCheck(nextCwd, nextState)
      }
    }
  }
}
