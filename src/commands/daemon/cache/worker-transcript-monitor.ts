import { Worker } from "node:worker_threads"
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
import {
  PendingRequestRegistry,
  RpcFailure,
  type RpcMetrics,
  type RpcScheduler,
  scheduleRpcTimeout,
  validateRpcLimit,
} from "./worker-rpc.ts"

export type TranscriptWorker = Pick<Worker, "on" | "off" | "postMessage" | "terminate" | "unref">

export interface WorkerTranscriptMonitorOptions {
  maxConcurrentChecks?: number
  maxQueueDepth?: number
  onCheckCompleted?: TranscriptMonitorCoordinatorOptions["onCheckCompleted"]
  initTimeoutMs?: number
  metricsTimeoutMs?: number
  maxRestarts?: number
  startupTimeoutMs?: number
  rpcTimeoutMs?: number
  checkTimeoutMs?: number
  maxPending?: number
  restartDelayMs?: number
  workerFactory?: () => TranscriptWorker
  schedule?: RpcScheduler
}

export interface WorkerRpcMetrics extends RpcMetrics {
  restarts: number
  unavailable: boolean
}

export function transcriptWorkerOptions(
  env: NodeJS.ProcessEnv = process.env
): WorkerTranscriptMonitorOptions {
  const read = (key: string, fallback: number) => validateRpcLimit(Number(env[key] ?? fallback))
  return {
    startupTimeoutMs: read("SWIZ_TRANSCRIPT_WORKER_STARTUP_TIMEOUT_MS", 15_000),
    rpcTimeoutMs: read("SWIZ_TRANSCRIPT_WORKER_RPC_TIMEOUT_MS", 5_000),
    checkTimeoutMs: read("SWIZ_TRANSCRIPT_WORKER_CHECK_TIMEOUT_MS", 60_000),
    maxPending: read("SWIZ_TRANSCRIPT_WORKER_MAX_PENDING", 128),
    restartDelayMs: read("SWIZ_TRANSCRIPT_WORKER_RESTART_DELAY_MS", 250),
  }
}

type CheckResult = { durationMs: number; error?: string; skipped?: boolean }
type DispatchMetrics = { active: number; queued: number; maxConcurrent: number }

/** Restart lazily on the next trigger; a failed attempt never recursively retries itself. */
export class WorkerTranscriptMonitor
  implements Pick<TranscriptMonitor, "checkProject" | "pruneOldSessions" | "terminate">
{
  private worker: TranscriptWorker | null = null
  private ready: Promise<TranscriptWorker> | null = null
  private generation = 0
  private stopped = false
  private unavailable = false
  private degraded = false
  private restarts = 0
  private attempts = 0
  private workerTimeouts = 0
  private workerFailures = 0
  private memorySnapshot: WorkerMemorySnapshot | null = null
  private disposeWorker = () => {}
  private cancelLaunch = () => {}
  private rpc: PendingRequestRegistry
  private coordinator: TranscriptMonitorCoordinator
  private schedule: RpcScheduler

  constructor(
    private caches: ConstructorParameters<typeof TranscriptMonitor>[0],
    private options: WorkerTranscriptMonitorOptions = {}
  ) {
    for (const limit of [
      options.startupTimeoutMs,
      options.initTimeoutMs,
      options.metricsTimeoutMs,
      options.checkTimeoutMs,
      options.restartDelayMs,
    ]) {
      if (limit !== undefined) validateRpcLimit(limit)
    }
    if (
      options.maxRestarts !== undefined &&
      (!Number.isSafeInteger(options.maxRestarts) || options.maxRestarts < 0)
    ) {
      throw new Error("Invalid transcript worker restart limit")
    }
    this.schedule = options.schedule ?? scheduleRpcTimeout
    this.rpc = new PendingRequestRegistry({
      defaultTimeoutMs: options.rpcTimeoutMs,
      maxPending: options.maxPending,
      schedule: this.schedule,
    })
    this.coordinator = new TranscriptMonitorCoordinator({
      ...options,
      executeCheck: (cwd) => this.executeWorkerCheck(cwd),
    })
    void this.ensureWorker().catch(() => {})
  }

  private ensureWorker(): Promise<TranscriptWorker> {
    if (this.stopped) return Promise.reject(new RpcFailure("CLOSED"))
    if (this.unavailable) return Promise.reject(new RpcFailure("UNAVAILABLE"))
    if (this.ready) return this.ready
    const generation = ++this.generation
    const restarting = this.attempts++ > 0
    const ready = this.rpc
      .request<void>(
        (id) => {
          const launch = () => this.launchWorker(generation, id, restarting)
          if (restarting)
            this.cancelLaunch = this.schedule(launch, this.options.restartDelayMs ?? 250)
          else launch()
        },
        {
          timeoutMs:
            (this.options.startupTimeoutMs ?? this.options.initTimeoutMs ?? 15_000) +
            (restarting ? (this.options.restartDelayMs ?? 250) : 0),
        }
      )
      .then(() => {
        if (!this.worker || generation !== this.generation) throw new RpcFailure("WORKER_EXIT")
        return this.worker
      })
    this.ready = ready
    void ready.catch(() => {
      if (this.ready === ready) this.ready = null
      this.failWorker(generation)
    })
    return ready
  }

  private launchWorker(generation: number, id: string, restarting: boolean): void {
    if (!this.rpc.has(id) || this.stopped) return
    if (restarting) this.restarts++
    try {
      const worker =
        this.options.workerFactory?.() ??
        new Worker(new URL("./transcript-monitor-worker.ts", import.meta.url))
      this.worker = worker
      const message = (msg: TranscriptMonitorParentMessage) => {
        if (generation === this.generation) this.handleMessage(worker, msg)
      }
      const fail = () => this.failWorker(generation)
      worker.on("message", message)
      worker.on("error", fail)
      worker.on("exit", fail)
      this.disposeWorker = () => {
        worker.off("message", message)
        worker.off("error", fail)
        worker.off("exit", fail)
        void worker.terminate().catch(() => {})
      }
      worker.unref()
      worker.postMessage({
        type: "init",
        id,
        rpcTimeoutMs: this.rpc.timeoutMs,
        maxPending: this.rpc.maxPending,
      } satisfies TranscriptMonitorWorkerMessage)
      worker.postMessage({
        type: "memoryPressure",
        degraded: this.degraded,
      } satisfies TranscriptMonitorWorkerMessage)
    } catch {
      this.rpc.reject(id, new RpcFailure("REMOTE"))
      this.failWorker(generation)
    }
  }

  private failWorker(generation: number): void {
    if (generation !== this.generation) return
    this.generation++
    if (!this.stopped) {
      this.workerFailures++
      this.unavailable = this.restarts >= (this.options.maxRestarts ?? 3)
    }
    this.workerTimeouts += this.memorySnapshot?.rpcTimeouts ?? 0
    this.workerFailures += this.memorySnapshot?.rpcFailures ?? 0
    this.memorySnapshot = null
    this.worker = null
    this.ready = null
    this.cancelLaunch()
    this.disposeWorker()
    this.disposeWorker = () => {}
    this.rpc.rejectAll(new RpcFailure("WORKER_EXIT"))
  }

  private handleMessage(worker: TranscriptWorker, msg: TranscriptMonitorParentMessage): void {
    switch (msg.type) {
      case "initialized":
        this.rpc.resolve(msg.id, undefined)
        break
      case "rpcError":
        this.rpc.reject(msg.id, new RpcFailure(msg.code))
        break
      case "memorySnapshot":
        this.memorySnapshot = msg.snapshot
        break
      case "checkProjectResponse":
        this.rpc.resolve(msg.id, {
          durationMs: msg.durationMs,
          error: msg.error,
          skipped: msg.skipped,
        })
        break
      case "dispatchConcurrencyMetricsResponse":
        this.rpc.resolve(msg.requestId, msg.metrics)
        break
      default:
        void this.serveWorker(worker, msg)
    }
  }

  private async serveWorker(
    worker: TranscriptWorker,
    msg: Extract<
      TranscriptMonitorParentMessage,
      { type: "getManifest" | "getSettings" | "checkAndMarkCooldown" }
    >
  ): Promise<void> {
    const id = "id" in msg ? msg.id : msg.requestId
    try {
      const response = await this.rpc.serve<TranscriptMonitorWorkerMessage>(async () => {
        switch (msg.type) {
          case "getManifest":
            return {
              type: "manifestResponse",
              id,
              manifest: await this.caches.manifestCache.get(msg.cwd),
            }
          case "getSettings":
            return {
              type: "settingsResponse",
              id,
              settings: (await this.caches.projectSettingsCache.get(msg.cwd)).settings,
            }
          case "checkAndMarkCooldown":
            return {
              type: "cooldownCheckResponse",
              requestId: id,
              withinCooldown: await this.caches.cooldownRegistry.checkAndMark(
                msg.hookId,
                msg.cooldown,
                msg.cwd
              ),
            }
        }
      })
      if (this.worker === worker) worker.postMessage(response)
    } catch (error) {
      if (this.worker !== worker) return
      try {
        worker.postMessage({
          type: "rpcError",
          id,
          code: error instanceof RpcFailure ? error.code : "REMOTE",
        } satisfies TranscriptMonitorWorkerMessage)
      } catch {
        this.failWorker(this.generation)
      }
    }
  }

  private request<T>(
    message: (id: string) => TranscriptMonitorWorkerMessage,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.stopped) return Promise.reject(new RpcFailure("CLOSED"))
    if (signal?.aborted) return Promise.reject(new RpcFailure("ABORTED"))
    if (this.unavailable) return Promise.reject(new RpcFailure("UNAVAILABLE"))
    const ready = this.ensureWorker()
    const generation = this.generation
    const result = this.rpc.request<T>(
      (id) => {
        void ready
          .then((worker) => {
            if (this.rpc.has(id)) worker.postMessage(message(id))
          })
          .catch(() => {
            this.rpc.reject(id, new RpcFailure("WORKER_EXIT"))
            this.failWorker(generation)
          })
      },
      { timeoutMs, signal }
    )
    return result.catch((error: unknown) => {
      if (error instanceof RpcFailure && error.code === "TIMEOUT") this.failWorker(generation)
      throw error
    })
  }

  private executeWorkerCheck(cwd: string): Promise<CheckResult> {
    if (this.degraded) return Promise.resolve({ durationMs: 0, skipped: true })
    return this.request(
      (id) => ({ type: "checkProject", id, cwd }),
      this.options.checkTimeoutMs ?? 60_000
    )
  }

  async checkProject(cwd: string): Promise<void> {
    if (this.stopped) throw new RpcFailure("CLOSED")
    if (this.unavailable) throw new RpcFailure("UNAVAILABLE")
    if (!this.degraded) await this.coordinator.checkProject(cwd)
  }

  getCoordinatorMetrics(): TranscriptMonitorCoordinatorMetrics {
    return this.coordinator.getMetrics()
  }

  getRpcMetrics(): WorkerRpcMetrics {
    const metrics = this.rpc.getMetrics()
    return {
      ...metrics,
      serving: this.rpc.servingCount,
      unavailable: this.unavailable,
      pending: metrics.pending + (this.memorySnapshot?.pendingRequests ?? 0),
      timeouts: metrics.timeouts + this.workerTimeouts + (this.memorySnapshot?.rpcTimeouts ?? 0),
      failures: metrics.failures + this.workerFailures + (this.memorySnapshot?.rpcFailures ?? 0),
      restarts: this.restarts,
    }
  }

  getDispatchConcurrencyMetrics(signal?: AbortSignal): Promise<DispatchMetrics> {
    return this.request<DispatchMetrics>(
      (requestId) => ({ type: "getDispatchConcurrencyMetrics", requestId }),
      this.options.metricsTimeoutMs ?? 5_000,
      signal
    )
  }

  getMemorySnapshot(now = Date.now()): WorkerMemorySnapshot | null {
    return this.memorySnapshot && now - this.memorySnapshot.sampledAt <= 90_000
      ? this.memorySnapshot
      : null
  }

  setMemoryPressure(degraded: boolean): void {
    this.degraded = degraded
    this.post({ type: "memoryPressure", degraded })
  }

  pruneOldSessions(activeSessions: Set<string>): void {
    this.post({ type: "pruneOldSessions", activeSessions: Array.from(activeSessions) })
  }

  private post(message: TranscriptMonitorWorkerMessage): void {
    try {
      this.worker?.postMessage(message)
    } catch {
      this.failWorker(this.generation)
    }
  }

  terminate(): void {
    if (this.stopped) return
    this.stopped = true
    this.coordinator.close("Worker terminated")
    this.rpc.close()
    this.failWorker(this.generation)
  }
}
