import type { WorkerMemorySnapshot } from "../memory-pressure.ts"
import type {
  TranscriptMonitorParentMessage,
  TranscriptMonitorWorkerMessage,
} from "../worker-messages.ts"
import { TranscriptMonitor } from "./transcript-monitor.ts"
import { PendingRequestRegistry, RpcFailure, type RpcScheduler } from "./worker-rpc.ts"

type Monitor = Pick<
  TranscriptMonitor,
  "checkProject" | "pruneOldSessions" | "getDispatchConcurrencyMetrics" | "terminate"
>
type Caches = ConstructorParameters<typeof TranscriptMonitor>[0]

/** Worker-side dispatcher, shared by the real worker and deterministic lifecycle tests. */
export class TranscriptWorkerRuntime {
  private rpc = new PendingRequestRegistry()
  private monitor: Monitor | null = null
  private degraded = false
  private activeChecks = 0
  private closed = false

  constructor(
    private send: (message: TranscriptMonitorParentMessage) => void,
    private createMonitor: (caches: Caches) => Monitor = (caches) => new TranscriptMonitor(caches),
    private schedule?: RpcScheduler,
    private changed: () => void = () => {}
  ) {}

  handle(msg: TranscriptMonitorWorkerMessage): void {
    if (this.closed) return
    try {
      if (!this.settleResponse(msg)) this.handleRequest(msg)
    } catch {
      const id = "id" in msg ? msg.id : "requestId" in msg ? msg.requestId : undefined
      if (id !== undefined) this.send({ type: "rpcError", id, code: "REMOTE" })
    }
  }

  private settleResponse(msg: TranscriptMonitorWorkerMessage): boolean {
    switch (msg.type) {
      case "manifestResponse":
        this.rpc.resolve(msg.id, msg.manifest)
        return true
      case "settingsResponse":
        this.rpc.resolve(msg.id, { settings: msg.settings })
        return true
      case "cooldownCheckResponse":
        this.rpc.resolve(msg.requestId, msg.withinCooldown)
        return true
      case "rpcError":
        this.rpc.reject(msg.id, new RpcFailure(msg.code))
        return true
      default:
        return false
    }
  }

  private handleRequest(msg: TranscriptMonitorWorkerMessage): void {
    switch (msg.type) {
      case "init":
        this.initialize(msg)
        this.changed()
        break
      case "memoryPressure":
        this.degraded = msg.degraded
        this.changed()
        break
      case "checkProject":
        void this.checkProject(msg.id, msg.cwd)
        break
      case "pruneOldSessions":
        this.monitor?.pruneOldSessions(new Set(msg.activeSessions))
        break
      case "getDispatchConcurrencyMetrics":
        if (!this.monitor) throw new RpcFailure("REMOTE")
        this.send({
          type: "dispatchConcurrencyMetricsResponse",
          requestId: msg.requestId,
          metrics: this.monitor.getDispatchConcurrencyMetrics(),
        })
        break
    }
  }

  private initialize(msg: Extract<TranscriptMonitorWorkerMessage, { type: "init" }>): void {
    this.rpc.close()
    this.monitor?.terminate()
    this.rpc = new PendingRequestRegistry({
      defaultTimeoutMs: msg.rpcTimeoutMs,
      maxPending: msg.maxPending,
      schedule: this.schedule,
    })
    this.monitor = this.createMonitor({
      manifestCache: {
        get: (cwd) => this.rpc.request((id) => this.send({ type: "getManifest", id, cwd })),
      },
      projectSettingsCache: {
        get: (cwd) => this.rpc.request((id) => this.send({ type: "getSettings", id, cwd })),
      },
      cooldownRegistry: {
        checkAndMark: (hookId, cooldown, cwd) =>
          this.rpc.request((requestId) =>
            this.send({ type: "checkAndMarkCooldown", requestId, hookId, cooldown, cwd })
          ),
      },
    })
    this.send({ type: "initialized", id: msg.id })
  }

  private async checkProject(id: string, cwd: string): Promise<void> {
    if (!this.monitor || this.degraded) {
      this.send({ type: "checkProjectResponse", id, cwd, durationMs: 0, skipped: true })
      return
    }
    this.activeChecks++
    const startedAt = performance.now()
    let error: string | undefined
    try {
      await this.monitor.checkProject(cwd)
    } catch {
      error = "Transcript monitor check failed"
    } finally {
      this.activeChecks--
      if (!this.closed) {
        this.send({
          type: "checkProjectResponse",
          id,
          cwd,
          durationMs: performance.now() - startedAt,
          ...(error && { error }),
        })
        this.changed()
      }
    }
  }

  snapshot(): Pick<
    WorkerMemorySnapshot,
    | "degraded"
    | "activeChecks"
    | "pendingRequests"
    | "rpcTimeouts"
    | "rpcFailures"
    | "activeDispatches"
    | "queuedDispatches"
  > {
    const rpc = this.rpc.getMetrics()
    const dispatch = this.monitor?.getDispatchConcurrencyMetrics()
    return {
      degraded: this.degraded,
      activeChecks: this.activeChecks,
      pendingRequests: rpc.pending,
      rpcTimeouts: rpc.timeouts,
      rpcFailures: rpc.failures,
      activeDispatches: dispatch?.active ?? 0,
      queuedDispatches: dispatch?.queued ?? 0,
    }
  }

  close(): void {
    this.closed = true
    this.rpc.close()
    this.monitor?.terminate()
  }
}
