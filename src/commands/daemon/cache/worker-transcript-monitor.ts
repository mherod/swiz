import { dirname, join } from "node:path"
import { Worker } from "node:worker_threads"
import { stderrLog } from "../../../debug.ts"
import type {
  TranscriptMonitorParentMessage,
  TranscriptMonitorWorkerMessage,
} from "../worker-messages.ts"
import type { TranscriptMonitor } from "./transcript-monitor.ts"

/**
 * A proxy for TranscriptMonitor that runs its operations in a background worker.
 */
export class WorkerTranscriptMonitor
  implements Pick<TranscriptMonitor, "checkProject" | "pruneOldSessions" | "terminate">
{
  private worker: Worker
  private initialized: Promise<void>

  constructor(private caches: ConstructorParameters<typeof TranscriptMonitor>[0]) {
    const workerPath = join(
      dirname(new URL(import.meta.url).pathname),
      "transcript-monitor-worker.ts"
    )
    this.worker = new Worker(workerPath)

    const handleWorkerMessage = async (msg: TranscriptMonitorParentMessage): Promise<void> => {
      try {
        switch (msg.type) {
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
      if (code !== 0) {
        stderrLog("worker-transcript-monitor", `Worker stopped with exit code ${code}`)
      }
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

  async checkProject(cwd: string): Promise<void> {
    await this.initialized
    this.worker.postMessage({ type: "checkProject", cwd } satisfies TranscriptMonitorWorkerMessage)
  }

  pruneOldSessions(activeSessions: Set<string>): void {
    // Note: pruneOldSessions is async-ish in the worker but we don't necessarily need to wait
    this.worker.postMessage({
      type: "pruneOldSessions",
      activeSessions: Array.from(activeSessions),
    } satisfies TranscriptMonitorWorkerMessage)
  }

  terminate(): void {
    void this.worker.terminate()
  }
}
