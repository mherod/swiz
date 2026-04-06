/**
 * Worker pool for parallel hook execution.
 * Manages multiple workers and distributes hook execution across them.
 */

import { randomUUID } from "node:crypto"
import { cpus } from "node:os"
import { join } from "node:path"
import { debugLog } from "../debug.ts"
import type { HookExecution } from "./engine.ts"
import type { ErrorResult, RunHookMessage } from "./worker-types.ts"

/** Grace period added to the hook's own timeout for supervisor-level enforcement (seconds).
 *  Accounts for worker startup, message passing, and SIGKILL escalation time. */
const SUPERVISOR_GRACE_SEC = 10

function getWorkerCount(): number {
  return Math.max(1, cpus().length - 1)
}

// Bun exposes Worker as a global - add types for TypeScript
type BunWorker = Pick<globalThis.Worker, "postMessage" | "onmessage" | "onerror" | "terminate">

interface HookResult {
  id: string
  type: "hook-result"
  parsed: Record<string, unknown> | null
  execution: HookExecution
}

type WorkerMessage = HookResult | ErrorResult

interface QueuedHook {
  id: string
  file: string
  payloadStr: string
  timeoutSec?: number
  /** Filled when the job is assigned to a worker (for error recovery). */
  workerIndex?: number
  /** Supervisor-level timeout timer — fires if worker doesn't respond in time. */
  supervisorTimer?: ReturnType<typeof setTimeout>
  resolve: (result: { parsed: Record<string, unknown> | null; execution: HookExecution }) => void
  reject: (error: Error) => void
}

/**
 * Worker pool for parallel hook execution.
 * Creates a fixed number of workers and distributes work across them.
 */
export class WorkerPool {
  private workers: BunWorker[] = []
  private queue: QueuedHook[] = []
  private workerBusy: boolean[] = []
  private pendingMessages = new Map<string, QueuedHook>()
  private initialized = false
  /** True while `processQueue` is draining — nested calls defer via `deferredProcess` + microtask. */
  private processing = false
  /** Set when `processQueue` is re-entered while `processing` — tail drain scheduled in `finally`. */
  private deferredProcess = false
  /** Set during `terminate()` so a tail `queueMicrotask` does not touch torn-down state. */
  private shutdown = false

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.shutdown = false

    const workerPath = join(import.meta.dir, "hook-worker.ts")

    const workerCount = getWorkerCount()
    for (let i = 0; i < workerCount; i++) {
      const workerIndex = i
      const worker = new Worker(workerPath)

      worker.onmessage = (event: MessageEvent) => {
        this.handleWorkerMessage(event.data as WorkerMessage, workerIndex)
      }

      worker.onerror = (error) => {
        debugLog(`Worker ${workerIndex} error: ${error}`)
        const err =
          error instanceof ErrorEvent && error.error instanceof Error
            ? error.error
            : new Error(String(error))
        this.handleWorkerFailure(workerIndex, err)
      }

      this.workers.push(worker)
      this.workerBusy.push(false)
    }

    this.initialized = true
  }

  private handleWorkerMessage(msg: WorkerMessage, workerIndex: number): void {
    this.workerBusy[workerIndex] = false

    const pending = this.pendingMessages.get(msg.id)
    if (!pending) {
      this.processQueue()
      return
    }

    this.pendingMessages.delete(msg.id)
    if (pending.supervisorTimer) clearTimeout(pending.supervisorTimer)

    if (msg.type === "hook-error") {
      pending.reject(new Error(msg.error))
    } else {
      pending.resolve({
        parsed: msg.parsed,
        execution: msg.execution,
      })
    }

    this.processQueue()
  }

  /** Worker crashed or failed to load — reject the in-flight job and free the slot. */
  private handleWorkerFailure(workerIndex: number, err: Error): void {
    this.workerBusy[workerIndex] = false
    for (const [id, pending] of this.pendingMessages) {
      if (pending.workerIndex === workerIndex) {
        this.pendingMessages.delete(id)
        if (pending.supervisorTimer) clearTimeout(pending.supervisorTimer)
        pending.reject(err)
        this.processQueue()
        return
      }
    }
    this.processQueue()
  }

  /**
   * Assign queued hooks to idle workers. Serialized: only one active drain at a time; synchronous
   * re-entry (e.g. worker `onmessage` in the same turn) sets `deferredProcess` and a microtask
   * continues draining so work is not stuck behind an early return.
   */
  private processQueue(): void {
    if (this.shutdown) return
    if (this.queue.length === 0) return
    if (this.processing) {
      this.deferredProcess = true
      return
    }

    this.processing = true
    try {
      while (this.queue.length > 0) {
        // Find idle worker
        const idleIndex = this.workerBusy.findIndex((busy) => !busy)
        if (idleIndex === -1) break

        const hook = this.queue.shift()
        if (!hook) break

        this.workerBusy[idleIndex] = true
        hook.workerIndex = idleIndex
        this.pendingMessages.set(hook.id, hook)
        const worker = this.workers[idleIndex]!

        // Start supervisor timeout — if the worker doesn't respond within
        // hookTimeout + grace, reject the promise and free the worker slot.
        const supervisorMs = ((hook.timeoutSec ?? 10) + SUPERVISOR_GRACE_SEC) * 1000
        hook.supervisorTimer = setTimeout(() => {
          if (!this.pendingMessages.has(hook.id)) return // already resolved
          this.pendingMessages.delete(hook.id)
          this.workerBusy[idleIndex] = false
          debugLog(`Worker pool: supervisor timeout for ${hook.file} (${supervisorMs}ms)`)
          hook.reject(
            new Error(
              `Supervisor timeout: worker did not respond within ${supervisorMs}ms for ${hook.file}`
            )
          )
          // Terminate and replace the stuck worker
          this.replaceWorker(idleIndex)
          this.processQueue()
        }, supervisorMs)

        const msg: RunHookMessage = {
          id: hook.id,
          type: "run-hook",
          file: hook.file,
          payloadStr: hook.payloadStr,
          timeoutSec: hook.timeoutSec,
        }

        worker.postMessage(msg)
      }
    } finally {
      this.processing = false
      const scheduleTail = this.deferredProcess && this.queue.length > 0
      this.deferredProcess = false
      if (scheduleTail) {
        queueMicrotask(() => {
          if (!this.shutdown) this.processQueue()
        })
      }
    }
  }

  /**
   * Queue a hook for execution in the worker pool.
   * Returns a promise that resolves with the hook result.
   * When an abort signal is provided, queued jobs are rejected immediately
   * on abort, and in-flight jobs are left to their per-hook timeout.
   */
  async runHook(
    file: string,
    payloadStr: string,
    timeoutSec?: number,
    signal?: AbortSignal
  ): Promise<{ parsed: Record<string, any> | null; execution: HookExecution }> {
    if (!this.initialized) {
      await this.initialize()
    }

    // If already aborted, reject immediately without queuing.
    if (signal?.aborted) {
      const now = Date.now()
      return {
        parsed: null,
        execution: {
          file,
          startTime: now,
          endTime: now,
          durationMs: 0,
          configuredTimeoutSec: timeoutSec ?? 10,
          status: "aborted",
          exitCode: null,
          stdoutSnippet: "",
          stderrSnippet: "",
        },
      }
    }

    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const hook: QueuedHook = {
        id,
        file,
        payloadStr,
        timeoutSec,
        resolve,
        reject,
      }

      // Listen for abort signal — reject queued jobs immediately, and for
      // in-flight jobs let the worker's per-hook timeout handle cleanup.
      const onAbort = () => {
        // If still in queue (not yet dispatched to a worker), remove and reject.
        const queueIdx = this.queue.indexOf(hook)
        if (queueIdx !== -1) {
          this.queue.splice(queueIdx, 1)
          const now = Date.now()
          resolve({
            parsed: null,
            execution: {
              file,
              startTime: now,
              endTime: now,
              durationMs: 0,
              configuredTimeoutSec: timeoutSec ?? 10,
              status: "aborted",
              exitCode: null,
              stdoutSnippet: "",
              stderrSnippet: "",
            },
          })
          return
        }
        // If already dispatched to a worker, the supervisor timer will handle
        // eventual cleanup. We also terminate+replace the stuck worker to
        // aggressively reclaim the slot.
        if (hook.workerIndex !== undefined && this.pendingMessages.has(id)) {
          this.pendingMessages.delete(id)
          if (hook.supervisorTimer) clearTimeout(hook.supervisorTimer)
          this.workerBusy[hook.workerIndex] = false
          debugLog(`Worker pool: abort signal — terminating worker ${hook.workerIndex} for ${file}`)
          this.replaceWorker(hook.workerIndex)
          const now = Date.now()
          resolve({
            parsed: null,
            execution: {
              file,
              startTime: now,
              endTime: now,
              durationMs: 0,
              configuredTimeoutSec: timeoutSec ?? 10,
              status: "aborted",
              exitCode: null,
              stdoutSnippet: "",
              stderrSnippet: "",
            },
          })
          this.processQueue()
        }
      }
      signal?.addEventListener("abort", onAbort, { once: true })

      this.queue.push(hook)
      this.processQueue()
    })
  }

  /** Terminate a stuck worker and spin up a replacement in the same slot. */
  private replaceWorker(workerIndex: number): void {
    const oldWorker = this.workers[workerIndex]
    if (oldWorker) {
      try {
        oldWorker.terminate()
      } catch {
        // Worker may already be dead
      }
    }
    const workerPath = join(import.meta.dir, "hook-worker.ts")
    const replacement = new Worker(workerPath)
    replacement.onmessage = (event: MessageEvent) => {
      this.handleWorkerMessage(event.data as WorkerMessage, workerIndex)
    }
    replacement.onerror = (error) => {
      debugLog(`Worker ${workerIndex} (replaced) error: ${error}`)
      const err =
        error instanceof ErrorEvent && error.error instanceof Error
          ? error.error
          : new Error(String(error))
      this.handleWorkerFailure(workerIndex, err)
    }
    this.workers[workerIndex] = replacement
    debugLog(`Worker pool: replaced stuck worker at index ${workerIndex}`)
  }

  /**
   * Terminate all workers and clean up.
   * Rejects all pending and queued hook executions with a shutdown error.
   */
  terminate(): void {
    this.shutdown = true
    this.deferredProcess = false
    const shutdownError = new Error("Worker pool terminated: process shutting down")
    for (const [, pending] of this.pendingMessages) {
      if (pending.supervisorTimer) clearTimeout(pending.supervisorTimer)
      pending.reject(shutdownError)
    }
    for (const queued of this.queue) {
      if (queued.supervisorTimer) clearTimeout(queued.supervisorTimer)
      queued.reject(shutdownError)
    }
    for (const worker of this.workers) {
      worker.terminate()
    }
    this.workers = []
    this.workerBusy = []
    this.queue = []
    this.pendingMessages.clear()
    this.initialized = false
    this.processing = false
    this.deferredProcess = false
  }
}

// Singleton instance
let pool: WorkerPool | null = null

/**
 * Get the shared worker pool instance.
 */
export function getWorkerPool(): WorkerPool {
  if (!pool) {
    pool = new WorkerPool()
    process.on("exit", () => pool?.terminate())
    const signalHandler = () => {
      pool?.terminate()
      process.exit(0)
    }
    process.on("SIGTERM", signalHandler)
    process.on("SIGINT", signalHandler)
  }
  return pool
}

/**
 * Run a hook in a worker (convenience function).
 */
export async function runHookInWorker(
  file: string,
  payloadStr: string,
  timeoutSec?: number,
  signal?: AbortSignal
): Promise<{ parsed: Record<string, any> | null; execution: HookExecution }> {
  return getWorkerPool().runHook(file, payloadStr, timeoutSec, signal)
}
