/**
 * Worker pool for parallel hook execution.
 * Manages multiple workers and distributes hook execution across them.
 */

import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { debugLog } from "../debug.ts"

const WORKER_COUNT = Math.max(1, (await import("node:os").then((os) => os.cpus().length)) - 1)

// Bun exposes Worker as a global - add types for TypeScript
type BunWorker = Pick<globalThis.Worker, "postMessage" | "onmessage" | "onerror" | "terminate">

interface RunHookMessage {
  id: string
  type: "run-hook"
  file: string
  payloadStr: string
  timeoutSec?: number
}

export interface HookExecution {
  file: string
  startTime: number
  endTime: number
  durationMs: number
  configuredTimeoutSec: number
  status: string
  exitCode: number | null
  stdoutSnippet: string
  stderrSnippet: string
}

interface HookResult {
  id: string
  type: "hook-result"
  parsed: Record<string, unknown> | null
  execution: HookExecution
}

interface ErrorResult {
  id: string
  type: "hook-error"
  error: string
}

type WorkerMessage = HookResult | ErrorResult

interface QueuedHook {
  id: string
  file: string
  payloadStr: string
  timeoutSec?: number
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

  async initialize(): Promise<void> {
    if (this.initialized) return

    const workerPath = join(import.meta.dir, "hook-worker.ts")

    for (let i = 0; i < WORKER_COUNT; i++) {
      const worker = new Worker(workerPath)

      worker.onmessage = (event: MessageEvent) => {
        this.handleWorkerMessage(event.data as WorkerMessage)
      }

      worker.onerror = (error) => {
        debugLog(`Worker ${i} error: ${error}`)
      }

      this.workers.push(worker)
      this.workerBusy.push(false)
    }

    this.initialized = true
  }

  private handleWorkerMessage(msg: WorkerMessage): void {
    const pending = this.pendingMessages.get(msg.id)
    if (!pending) return

    this.pendingMessages.delete(msg.id)

    if (msg.type === "hook-error") {
      pending.reject(new Error(msg.error))
    } else {
      pending.resolve({
        parsed: msg.parsed,
        execution: msg.execution,
      })
    }

    // Process next in queue
    this.processQueue()
  }

  private processQueue(): void {
    if (this.queue.length === 0) return

    // Find idle worker
    const idleIndex = this.workerBusy.findIndex((busy) => !busy)
    if (idleIndex === -1) return

    const hook = this.queue.shift()
    if (!hook) return

    this.workerBusy[idleIndex] = true
    const worker = this.workers[idleIndex]!

    const msg: RunHookMessage = {
      id: hook.id,
      type: "run-hook",
      file: hook.file,
      payloadStr: hook.payloadStr,
      timeoutSec: hook.timeoutSec,
    }

    worker.postMessage(msg)
  }

  /**
   * Queue a hook for execution in the worker pool.
   * Returns a promise that resolves with the hook result.
   */
  async runHook(
    file: string,
    payloadStr: string,
    timeoutSec?: number
  ): Promise<{ parsed: Record<string, unknown> | null; execution: HookExecution }> {
    if (!this.initialized) {
      await this.initialize()
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

      this.queue.push(hook)
      this.processQueue()
    })
  }

  /**
   * Terminate all workers and clean up.
   */
  terminate(): void {
    for (const worker of this.workers) {
      worker.terminate()
    }
    this.workers = []
    this.workerBusy = []
    this.queue = []
    this.pendingMessages.clear()
    this.initialized = false
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
  }
  return pool
}

/**
 * Run a hook in a worker (convenience function).
 */
export async function runHookInWorker(
  file: string,
  payloadStr: string,
  timeoutSec?: number
): Promise<{ parsed: Record<string, unknown> | null; execution: HookExecution }> {
  return getWorkerPool().runHook(file, payloadStr, timeoutSec)
}
