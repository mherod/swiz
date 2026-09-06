import { dirname, join } from "node:path"
import { Worker } from "node:worker_threads"
import { stderrLog } from "../../../debug.ts"
import type { WorkerMemorySnapshot } from "../memory-pressure.ts"
import type {
  TranscriptMonitorParentMessage,
  TranscriptMonitorWorkerMessage,
} from "../worker-messages.ts"
import type { TranscriptMonitor } from "./transcript-monitor.ts"
import {
  TranscriptMonitorCoordinator,
  type TranscriptMonitorCoordinatorMetrics,
  type TranscriptMonitorCoordinatorOptions,
} from "./transcript-monitor-coordinator.ts"
import { PendingRequestRegistry } from "./worker-rpc.ts"

export interface WorkerTranscriptMonitorOptions {
  maxConcurrentChecks?: number
  maxQueueDepth?: number
  onCheckCompleted?: TranscriptMonitorCoordinatorOptions["onCheckCompleted"]
  /** Deadline for the worker's `init` handshake. */
  initTimeoutMs?: number
  /** Deadline for a single project check round-trip. */
  checkTimeoutMs?: number
  /** Deadline for the dispatch-concurrency metrics request. */
  metricsTimeoutMs?: number
  /** How many times a crashed or stalled worker is replaced before giving up. */
  maxRestarts?: number
}

export interface WorkerRpcMetrics {
  pending: number
  timeouts: number
  failures: number
  restarts: number
  /** True once restarts are exhausted; the monitor serves nothing further. */
  unavailable: boolean
}

const DEFAULT_INIT_TIMEOUT_MS = 15_000
const DEFAULT_CHECK_TIMEOUT_MS = 60_000
const DEFAULT_METRICS_TIMEOUT_MS = 5_000
const DEFAULT_MAX_RESTARTS = 3

/**
 * A proxy for TranscriptMonitor that runs its operations in a background worker.
 *
 * Every request to the worker settles: on a reply, on an explicit error, or on a deadline. A
 * worker that crashes or stalls is replaced (up to `maxRestarts`) so later monitor triggers keep
 * working instead of being lost behind a promise that never resolves.
 */
export class WorkerTranscriptMonitor
  implements Pick<TranscriptMonitor, "checkProject" | "pruneOldSessions" | "terminate">
{
  private worker: Worker
  private initialized: Promise<void>
  private degraded = false
  private memorySnapshot: WorkerMemorySnapshot | null = null
  private coordinator: TranscriptMonitorCoordinator
  private readonly requests = new PendingRequestRegistry()
  private readonly options: WorkerTranscriptMonitorOptions
  private restarts = 0
  private shuttingDown = false
  private unavailable = false

  getMemorySnapshot(now = Date.now()): WorkerMemorySnapshot | null {
    return this.memorySnapshot && now - this.memorySnapshot.sampledAt <= 90_000
      ? this.memorySnapshot
      : null
  }

  setMemoryPressure(degraded: boolean): void {
    if (degraded) this.degraded = true
    this.worker.postMessage({
      type: "memoryPressure",
      degraded,
    } satisfies TranscriptMonitorWorkerMessage)
    this.degraded = degraded
  }

  constructor(
    private caches: ConstructorParameters<typeof TranscriptMonitor>[0],
    options?: WorkerTranscriptMonitorOptions
  ) {
    this.options = options ?? {}
    this.coordinator = this.createCoordinator()
    this.worker = this.spawnWorker()
    this.initialized = this.handshake()
  }

  private createCoordinator(): TranscriptMonitorCoordinator {
    return new TranscriptMonitorCoordinator({
      maxConcurrentChecks: this.options.maxConcurrentChecks,
      maxQueueDepth: this.options.maxQueueDepth,
      executeCheck: (cwd) => this.executeWorkerCheck(cwd),
      onCheckCompleted: this.options.onCheckCompleted,
    })
  }

  private spawnWorker(): Worker {
    const workerPath = join(
      dirname(new URL(import.meta.url).pathname),
      "transcript-monitor-worker.ts"
    )
    const worker = new Worker(workerPath)

    worker.on("message", (msg: TranscriptMonitorParentMessage): void => {
      void this.handleWorkerMessage(worker, msg)
    })

    worker.on("error", (err) => {
      stderrLog("worker-transcript-monitor", `Worker error: ${err}`)
      this.handleWorkerLoss(worker, `Worker error: ${err instanceof Error ? err.message : err}`)
    })

    worker.on("exit", (code) => {
      if (code !== 0) {
        stderrLog("worker-transcript-monitor", `Worker stopped with exit code ${code}`)
      }
      this.handleWorkerLoss(worker, `Worker exited with code ${code}`)
    })

    worker.unref()
    return worker
  }

  /** Ask the worker to build its monitor, under a bounded deadline. */
  private handshake(): Promise<void> {
    const id = "init"
    const promise = this.requests
      .register<void>(id, {
        timeoutMs: this.options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS,
        label: "init",
      })
      .then(() => undefined)
    this.worker.postMessage({ type: "init" } satisfies TranscriptMonitorWorkerMessage)
    // Mark handled so a rejected handshake nobody has awaited yet is not an unhandled rejection.
    // Awaiters still observe the rejection.
    promise.catch(() => {})
    return promise
  }

  /**
   * Settle everything waiting on a dead worker, then replace it so later triggers still run.
   * Ignores losses reported by a worker that has already been superseded.
   */
  private handleWorkerLoss(worker: Worker, reason: string): void {
    if (worker !== this.worker || this.shuttingDown || this.unavailable) return

    this.memorySnapshot = null
    this.requests.rejectAll(reason)
    this.coordinator.close(reason)

    if (this.restarts >= (this.options.maxRestarts ?? DEFAULT_MAX_RESTARTS)) {
      this.unavailable = true
      stderrLog(
        "worker-transcript-monitor",
        `Giving up after ${this.restarts} restart(s); transcript monitoring is unavailable.`
      )
      return
    }

    this.restarts++
    stderrLog(
      "worker-transcript-monitor",
      `Restarting worker (attempt ${this.restarts}): ${reason}`
    )
    // A closed coordinator rejects every future check, so replace it alongside the worker.
    this.coordinator = this.createCoordinator()
    this.worker = this.spawnWorker()
    this.initialized = this.handshake()
  }

  private async handleWorkerMessage(
    worker: Worker,
    msg: TranscriptMonitorParentMessage
  ): Promise<void> {
    // A late message from a replaced worker must not settle the current worker's requests.
    if (worker !== this.worker) return
    try {
      if (await this.handleServiceRequest(worker, msg)) return
      switch (msg.type) {
        case "initialized":
          if (msg.error) {
            this.requests.reject("init", new Error(msg.error))
          } else {
            this.requests.resolve("init", undefined)
          }
          break
        case "memorySnapshot":
          this.memorySnapshot = msg.snapshot
          break
        case "dispatchConcurrencyMetricsResponse": {
          if (msg.error) {
            this.requests.reject(msg.requestId, new Error(msg.error))
          } else {
            this.requests.resolve(msg.requestId, msg.metrics)
          }
          break
        }
        case "checkProjectResponse": {
          this.requests.resolve(msg.id, {
            durationMs: msg.durationMs,
            error: msg.error,
            skipped: msg.skipped,
          })
          break
        }
      }
    } catch (err) {
      stderrLog("worker-transcript-monitor-proxy", `Error handling worker message: ${err}`)
    }
  }

  /**
   * Serve the worker's parent-side lookups. Returns true when `msg` was such a request.
   */
  private async handleServiceRequest(
    worker: Worker,
    msg: TranscriptMonitorParentMessage
  ): Promise<boolean> {
    switch (msg.type) {
      case "getManifest":
        await this.replyOrError(worker, msg.id, "manifestResponse", async () => ({
          manifest: await this.caches.manifestCache.get(msg.cwd),
        }))
        return true
      case "getSettings":
        await this.replyOrError(worker, msg.id, "settingsResponse", async () => ({
          settings: (await this.caches.projectSettingsCache.get(msg.cwd)).settings,
        }))
        return true
      case "checkAndMarkCooldown":
        await this.replyOrError(
          worker,
          msg.requestId,
          "cooldownCheckResponse",
          async () => ({
            withinCooldown: await Promise.resolve(
              this.caches.cooldownRegistry.checkAndMark(msg.hookId, msg.cooldown, msg.cwd)
            ),
          }),
          "requestId"
        )
        return true
      default:
        return false
    }
  }

  /**
   * Run a parent-side lookup and reply. A thrown lookup sends a structured error reply rather
   * than leaving the worker waiting for its deadline.
   */
  private async replyOrError(
    worker: Worker,
    id: string,
    type: "manifestResponse" | "settingsResponse" | "cooldownCheckResponse",
    produce: () => Promise<Record<string, unknown>>,
    idField: "id" | "requestId" = "id"
  ): Promise<void> {
    let payload: Record<string, unknown>
    try {
      payload = await produce()
    } catch (err) {
      payload = {
        error: err instanceof Error ? err.message : String(err),
        // Type-satisfying defaults; the worker rejects on `error` and ignores these.
        ...(type === "manifestResponse" ? { manifest: [] } : {}),
        ...(type === "settingsResponse" ? { settings: null } : {}),
        ...(type === "cooldownCheckResponse" ? { withinCooldown: false } : {}),
      }
    }
    if (worker !== this.worker) return
    worker.postMessage({ type, [idField]: id, ...payload } as TranscriptMonitorWorkerMessage)
  }

  private executeWorkerCheck(cwd: string): Promise<{
    durationMs: number
    error?: string
    skipped?: boolean
  }> {
    if (this.degraded || this.unavailable) {
      return Promise.resolve({ durationMs: 0, skipped: true })
    }
    // Monotonic ids: a collision would silently orphan an earlier resolver and hang its check.
    const id = this.requests.nextId("check")
    const promise = this.requests.register<{
      durationMs: number
      error?: string
      skipped?: boolean
    }>(id, {
      timeoutMs: this.options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
      label: "checkProject",
    })
    this.worker.postMessage({
      type: "checkProject",
      id,
      cwd,
    } satisfies TranscriptMonitorWorkerMessage)
    return promise
  }

  async checkProject(cwd: string): Promise<void> {
    if (this.degraded || this.unavailable) return
    await this.initialized
    if (this.degraded || this.unavailable) return
    await this.coordinator.checkProject(cwd)
  }

  getCoordinatorMetrics(): TranscriptMonitorCoordinatorMetrics {
    return this.coordinator.getMetrics()
  }

  /** Aggregate RPC health only — no session content, file paths, or secrets. */
  getRpcMetrics(): WorkerRpcMetrics {
    return {
      ...this.requests.getMetrics(),
      restarts: this.restarts,
      unavailable: this.unavailable,
    }
  }

  pruneOldSessions(activeSessions: Set<string>): void {
    // Note: pruneOldSessions is async-ish in the worker but we don't necessarily need to wait
    this.worker.postMessage({
      type: "pruneOldSessions",
      activeSessions: Array.from(activeSessions),
    } satisfies TranscriptMonitorWorkerMessage)
  }

  getDispatchConcurrencyMetrics(): Promise<{
    active: number
    queued: number
    maxConcurrent: number
  }> {
    if (this.unavailable) {
      return Promise.reject(new Error("Transcript monitor worker is unavailable"))
    }
    const requestId = this.requests.nextId("metrics")
    const promise = this.requests.register<{
      active: number
      queued: number
      maxConcurrent: number
    }>(requestId, {
      timeoutMs: this.options.metricsTimeoutMs ?? DEFAULT_METRICS_TIMEOUT_MS,
      label: "dispatchConcurrencyMetrics",
    })
    this.worker.postMessage({
      type: "getDispatchConcurrencyMetrics",
      requestId,
    } satisfies TranscriptMonitorWorkerMessage)
    return promise
  }

  terminate(): void {
    this.shuttingDown = true
    this.requests.rejectAll("Worker terminated")
    this.coordinator.close("Worker terminated")
    void this.worker.terminate()
  }
}
