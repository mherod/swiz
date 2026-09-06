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

export interface WorkerTranscriptMonitorOptions {
  maxConcurrentChecks?: number
  maxQueueDepth?: number
  onCheckCompleted?: TranscriptMonitorCoordinatorOptions["onCheckCompleted"]
}

/**
 * A proxy for TranscriptMonitor that runs its operations in a background worker.
 */
export class WorkerTranscriptMonitor
  implements Pick<TranscriptMonitor, "checkProject" | "pruneOldSessions" | "terminate">
{
  private worker: Worker
  private initialized: Promise<void>
  private degraded = false
  private memorySnapshot: WorkerMemorySnapshot | null = null
  private coordinator: TranscriptMonitorCoordinator
  private inFlightChecks = new Map<
    string,
    (result: { durationMs: number; error?: string; skipped?: boolean }) => void
  >()
  private nextCheckId = 0

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
    const workerPath = join(
      dirname(new URL(import.meta.url).pathname),
      "transcript-monitor-worker.ts"
    )
    this.worker = new Worker(workerPath)

    this.coordinator = new TranscriptMonitorCoordinator({
      maxConcurrentChecks: options?.maxConcurrentChecks,
      maxQueueDepth: options?.maxQueueDepth,
      executeCheck: (cwd) => this.executeWorkerCheck(cwd),
      onCheckCompleted: options?.onCheckCompleted,
    })

    const handleWorkerMessage = async (msg: TranscriptMonitorParentMessage): Promise<void> => {
      try {
        switch (msg.type) {
          case "memorySnapshot":
            this.memorySnapshot = msg.snapshot
            break
          case "getManifest": {
            const manifest = await this.caches.manifestCache.get(msg.cwd)
            this.worker.postMessage({
              type: "manifestResponse",
              id: msg.id,
              manifest,
            } satisfies TranscriptMonitorWorkerMessage)
            break
          }
          case "getSettings": {
            const cached = await this.caches.projectSettingsCache.get(msg.cwd)
            this.worker.postMessage({
              type: "settingsResponse",
              id: msg.id,
              settings: cached.settings,
            } satisfies TranscriptMonitorWorkerMessage)
            break
          }
          case "checkAndMarkCooldown": {
            const raw = this.caches.cooldownRegistry.checkAndMark(msg.hookId, msg.cooldown, msg.cwd)
            const withinCooldown = await Promise.resolve(raw)
            this.worker.postMessage({
              type: "cooldownCheckResponse",
              requestId: msg.requestId,
              withinCooldown,
            } satisfies TranscriptMonitorWorkerMessage)
            break
          }
          case "checkProjectResponse": {
            const resolve = this.inFlightChecks.get(msg.id)
            if (resolve) {
              this.inFlightChecks.delete(msg.id)
              resolve({ durationMs: msg.durationMs, error: msg.error, skipped: msg.skipped })
            }
            break
          }
        }
      } catch (err) {
        stderrLog("worker-transcript-monitor-proxy", `Error handling worker message: ${err}`)
      }
    }
    this.worker.on(
      "message",
      (msg: TranscriptMonitorParentMessage): void => void handleWorkerMessage(msg)
    )

    this.worker.on("error", (err) => {
      stderrLog("worker-transcript-monitor", `Worker error: ${err}`)
    })

    this.worker.on("exit", (code) => {
      this.memorySnapshot = null
      if (code !== 0) {
        stderrLog("worker-transcript-monitor", `Worker stopped with exit code ${code}`)
      }
      for (const resolve of this.inFlightChecks.values()) {
        resolve({ durationMs: 0, error: `Worker exited with code ${code}` })
      }
      this.inFlightChecks.clear()
      this.coordinator.close(`Worker exited with code ${code}`)
    })

    this.worker.unref()

    this.initialized = new Promise((resolve) => {
      const handler = (msg: TranscriptMonitorParentMessage) => {
        if (msg.type === "initialized") {
          this.worker.off("message", handler)
          resolve()
        }
      }
      this.worker.on("message", handler)
      this.worker.postMessage({ type: "init" } satisfies TranscriptMonitorWorkerMessage)
    })
  }

  private executeWorkerCheck(cwd: string): Promise<{
    durationMs: number
    error?: string
    skipped?: boolean
  }> {
    if (this.degraded) {
      return Promise.resolve({ durationMs: 0, skipped: true })
    }
    // Monotonic ids: a collision would silently orphan an earlier resolver and hang its check.
    const id = `check-${this.nextCheckId++}`
    return new Promise((resolve) => {
      this.inFlightChecks.set(id, resolve)
      this.worker.postMessage({
        type: "checkProject",
        id,
        cwd,
      } satisfies TranscriptMonitorWorkerMessage)
    })
  }

  async checkProject(cwd: string): Promise<void> {
    if (this.degraded) return
    await this.initialized
    if (this.degraded) return
    await this.coordinator.checkProject(cwd)
  }

  getCoordinatorMetrics(): TranscriptMonitorCoordinatorMetrics {
    return this.coordinator.getMetrics()
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
    const requestId = Math.random().toString(36).slice(2, 11)
    return new Promise((resolve) => {
      const handler = (msg: TranscriptMonitorParentMessage) => {
        if (msg.type === "dispatchConcurrencyMetricsResponse" && msg.requestId === requestId) {
          this.worker.off("message", handler)
          resolve(msg.metrics)
        }
      }
      this.worker.on("message", handler)
      this.worker.postMessage({
        type: "getDispatchConcurrencyMetrics",
        requestId,
      } satisfies TranscriptMonitorWorkerMessage)
    })
  }

  terminate(): void {
    this.coordinator.close("Worker terminated")
    void this.worker.terminate()
  }
}
