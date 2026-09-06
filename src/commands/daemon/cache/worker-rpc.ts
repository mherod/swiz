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
  private readonly defaultTimeoutMs: number
  private readonly pending = new Map<string, PendingEntry>()
  private nextSequence = 0
  private timeoutCount = 0
  private failureCount = 0

  constructor(options?: { defaultTimeoutMs?: number }) {
    this.defaultTimeoutMs = Math.max(1, options?.defaultTimeoutMs ?? DEFAULT_WORKER_RPC_TIMEOUT_MS)
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
  register<T>(id: string, options?: RegisterRequestOptions): Promise<T> {
    const timeoutMs = Math.max(1, options?.timeoutMs ?? this.defaultTimeoutMs)
    const label = options?.label ?? id

    return new Promise<T>((resolve, reject) => {
      const existing = this.pending.get(id)
      if (existing) {
        reject(new Error(`Duplicate worker request id: ${id}`))
        return
      }

      const signal = options?.signal
      if (signal?.aborted) {
        this.failureCount++
        reject(new Error(`Worker request aborted before dispatch: ${label}`))
        return
      }

      let settled = false
      const finish = (): boolean => {
        if (settled) return false
        settled = true
        this.pending.delete(id)
        if (timer !== undefined) clearTimeout(timer)
        if (signal && onAbort) signal.removeEventListener("abort", onAbort)
        return true
      }

      const timer = setTimeout(() => {
        if (!finish()) return
        this.timeoutCount++
        this.failureCount++
        reject(new Error(`Worker request timed out after ${timeoutMs}ms: ${label}`))
      }, timeoutMs)
      // A pending RPC must never be the reason the process stays alive.
      ;(timer as { unref?: () => void }).unref?.()

      const onAbort = signal
        ? () => {
            if (!finish()) return
            this.failureCount++
            reject(new Error(`Worker request aborted: ${label}`))
          }
        : undefined
      if (signal && onAbort) signal.addEventListener("abort", onAbort, { once: true })

      this.pending.set(id, {
        resolve: (value) => {
          if (!finish()) return
          resolve(value as T)
        },
        reject: (error) => {
          if (!finish()) return
          this.failureCount++
          reject(error)
        },
        cleanup: finish,
      })
    })
  }

  /** Settle a pending request with its reply. Returns false when nothing was waiting. */
  resolve(id: string, value: unknown): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    entry.resolve(value as never)
    return true
  }

  /** Settle a pending request with a structured error. Returns false when nothing was waiting. */
  reject(id: string, error: Error): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    entry.reject(error)
    return true
  }

  /**
   * Reject everything still waiting — the peer died, was replaced, or is shutting down.
   * Returns how many requests were rejected.
   */
  rejectAll(reason: string | Error): number {
    const error = reason instanceof Error ? reason : new Error(reason)
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      entry.reject(error)
    }
    return entries.length
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
