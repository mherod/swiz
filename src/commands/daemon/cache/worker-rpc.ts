export type RpcFailureCode =
  | "TIMEOUT"
  | "ABORTED"
  | "CLOSED"
  | "CAPACITY"
  | "REMOTE"
  | "WORKER_EXIT"
  | "UNAVAILABLE"

export class RpcFailure extends Error {
  constructor(
    readonly code: RpcFailureCode,
    message = `Transcript worker RPC: ${code}`
  ) {
    super(message)
  }
}

export interface RpcMetrics {
  pending: number
  serving: number
  timeouts: number
  failures: number
}

export type RpcScheduler = (callback: () => void, delayMs: number) => () => void
export function validateRpcLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error("Invalid transcript RPC limit")
  }
  return value
}
export const scheduleRpcTimeout: RpcScheduler = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs)
  timer.unref()
  return () => clearTimeout(timer)
}

/**
 * Bounded request/response bookkeeping for Worker IPC.
 *
 * Both sides of the transcript-monitor worker boundary send request messages and wait for a
 * matching reply. Without bookkeeping each request needs its own `on("message")` listener that is
 * removed only on the success path, so a reply that never arrives leaks the listener, strands the
 * promise, and — when the caller holds a guard while awaiting — silently disables the caller's
 * whole loop.
 *
 * A registry replaces those per-request listeners with one router keyed by request id. Every
 * request settles exactly once: reply, explicit error, deadline, abort, or bulk rejection when the
 * peer dies.
 */

export interface PendingRequestMetrics {
  /** Requests currently awaiting a reply. */
  pending: number
  /** Requests that were rejected because their deadline expired. */
  timeouts: number
  /** Total rejections, including timeouts, aborts, explicit errors, and bulk rejections. */
  failures: number
}

export interface RegisterRequestOptions {
  /** Deadline in milliseconds. Falls back to the registry default. */
  timeoutMs?: number
  /** Cancels the request cooperatively; the promise rejects and the entry is cleaned up. */
  signal?: AbortSignal
  /** Short description used in timeout/abort messages. Must not contain session content or paths. */
  label?: string
}

interface PendingEntry {
  resolve: (value: never) => void
  reject: (error: Error) => void
  cleanup: () => void
}

/** Default deadline for a worker RPC that does not specify its own. */
export const DEFAULT_WORKER_RPC_TIMEOUT_MS = 15_000

export class PendingRequestRegistry {
  readonly timeoutMs: number
  readonly maxPending: number
  private readonly schedule: RpcScheduler
  private closed = false
  private serving = 0
  private readonly pending = new Map<string, PendingEntry>()
  private nextSequence = 0
  private timeoutCount = 0
  private failureCount = 0

  constructor(
    options: { defaultTimeoutMs?: number; maxPending?: number; schedule?: RpcScheduler } = {}
  ) {
    this.timeoutMs = validateRpcLimit(options.defaultTimeoutMs ?? DEFAULT_WORKER_RPC_TIMEOUT_MS)
    this.maxPending = validateRpcLimit(options.maxPending ?? 128)
    this.schedule = options.schedule ?? scheduleRpcTimeout
  }

  /**
   * Monotonic request id. Random ids risk collisions that silently orphan the earlier resolver,
   * which strands that request until its deadline instead of failing loudly.
   */
  nextId(prefix = "req"): string {
    return `${prefix}-${this.nextSequence++}`
  }

  /**
   * Await a reply for `id`. The returned promise always settles.
   */
  register<T>(id: string, options: RegisterRequestOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new RpcFailure("CLOSED"))
    if (this.pending.has(id)) return Promise.reject(new Error(`Duplicate worker request id: ${id}`))
    if (this.pending.size >= this.maxPending) return this.capacityFailure()
    const timeoutMs = validateRpcLimit(options.timeoutMs ?? this.timeoutMs)
    const label = options.label ?? id
    const signal = options.signal
    if (signal?.aborted) {
      this.failureCount++
      return Promise.reject(
        new RpcFailure("ABORTED", `Worker request aborted before dispatch: ${label}`)
      )
    }
    return new Promise<T>((resolve, reject) => {
      const abort = () =>
        this.reject(id, new RpcFailure("ABORTED", `Worker request aborted: ${label}`))
      const cancel = this.schedule(() => {
        this.reject(
          id,
          new RpcFailure("TIMEOUT", `Worker request timed out after ${timeoutMs}ms: ${label}`)
        )
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        cleanup: () => {
          cancel()
          signal?.removeEventListener("abort", abort)
        },
      })
      signal?.addEventListener("abort", abort, { once: true })
    })
  }

  /** Register before dispatch, so synchronous replies and transport errors also settle once. */
  request<T>(send: (id: string) => void, options?: RegisterRequestOptions): Promise<T> {
    const id = this.nextId()
    const promise = this.register<T>(id, options)
    if (this.has(id)) {
      try {
        send(id)
      } catch {
        this.reject(id, new RpcFailure("REMOTE"))
      }
    }
    return promise
  }

  /** Keep a separate execution cap: a timed-out service may ignore cancellation. */
  serve<T>(operation: () => T | Promise<T>, options: RegisterRequestOptions = {}): Promise<T> {
    if (this.serving >= this.maxPending) return this.capacityFailure()
    return this.request<T>((id) => {
      this.serving++
      void Promise.resolve()
        .then(() => {
          if (!this.has(id)) throw new RpcFailure("CLOSED")
          return operation()
        })
        .then(
          (value) => {
            this.serving--
            this.resolve(id, value)
          },
          () => {
            this.serving--
            this.reject(id, new RpcFailure("REMOTE"))
          }
        )
    }, options)
  }

  private capacityFailure<T>(): Promise<T> {
    this.failureCount++
    return Promise.reject(new RpcFailure("CAPACITY"))
  }

  get servingCount(): number {
    return this.serving
  }

  close(): void {
    this.closed = true
    this.rejectAll(new RpcFailure("CLOSED"))
  }

  /** Settle a pending request with its reply. Returns false when nothing was waiting. */
  resolve(id: string, value: unknown): boolean {
    const entry = this.take(id)
    if (!entry) return false
    entry.resolve(value as never)
    return true
  }

  /** Settle a pending request with a structured error. Returns false when nothing was waiting. */
  reject(id: string, error: Error): boolean {
    const entry = this.take(id)
    if (!entry) return false
    this.failureCount++
    if (error instanceof RpcFailure && error.code === "TIMEOUT") this.timeoutCount++
    entry.reject(error)
    return true
  }

  /**
   * Reject everything still waiting — the peer died, was replaced, or is shutting down.
   * Returns how many requests were rejected.
   */
  rejectAll(reason: string | Error): number {
    const error = reason instanceof Error ? reason : new Error(reason)
    const count = this.pending.size
    for (const id of this.pending.keys()) this.reject(id, error)
    return count
  }

  private take(id: string): PendingEntry | undefined {
    const entry = this.pending.get(id)
    if (entry) {
      this.pending.delete(id)
      entry.cleanup()
    }
    return entry
  }

  has(id: string): boolean {
    return this.pending.has(id)
  }

  get pendingCount(): number {
    return this.pending.size
  }

  /** Aggregate counters only — never request payloads, paths, or session content. */
  getMetrics(): PendingRequestMetrics {
    return {
      pending: this.pending.size,
      timeouts: this.timeoutCount,
      failures: this.failureCount,
    }
  }
}
