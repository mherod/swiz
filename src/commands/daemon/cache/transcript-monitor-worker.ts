import { parentPort } from "node:worker_threads"
import { stderrLog } from "../../../debug.ts"
import { getFileCacheMemoryStats } from "../../../utils/file-cache.ts"
import { releaseTranscriptHistory } from "../memory-relief.ts"
import type {
  TranscriptMonitorParentMessage,
  TranscriptMonitorWorkerMessage,
} from "../worker-messages.ts"
import { TranscriptMonitor } from "./transcript-monitor.ts"

if (!parentPort) {
  process.exit(1)
}

let monitor: TranscriptMonitor | null = null
let degraded = false
let activeChecks = 0
let pendingRequests = 0

function publishMemorySnapshot(): void {
  const memory = process.memoryUsage()
  const cache = getFileCacheMemoryStats()
  const dispatch = monitor?.getDispatchConcurrencyMetrics()
  parentPort?.postMessage({
    type: "memorySnapshot",
    snapshot: {
      sampledAt: Date.now(),
      degraded,
      heapUsed: memory.heapUsed,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
      activeChecks,
      pendingRequests,
      activeDispatches: dispatch?.active ?? 0,
      queuedDispatches: dispatch?.queued ?? 0,
      fileCacheEntries: cache.entries,
      fileCacheEstimatedBytes: cache.estimatedBytes,
    },
  } satisfies TranscriptMonitorParentMessage)
}

async function checkProject(id: string, cwd: string): Promise<void> {
  if (!monitor || degraded) {
    parentPort?.postMessage({
      type: "checkProjectResponse",
      id,
      cwd,
      durationMs: 0,
      skipped: true,
    } satisfies TranscriptMonitorParentMessage)
    return
  }
  activeChecks++
  const startedAt = performance.now()
  let error: string | undefined
  try {
    await monitor.checkProject(cwd)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    stderrLog("transcript-monitor-worker", `Error checking project: ${err}`)
  } finally {
    const durationMs = performance.now() - startedAt
    activeChecks--
    if (degraded) releaseTranscriptHistory()
    publishMemorySnapshot()
    parentPort?.postMessage({
      type: "checkProjectResponse",
      id,
      cwd,
      durationMs,
      ...(error !== undefined ? { error } : {}),
    } satisfies TranscriptMonitorParentMessage)
  }
}

if (parentPort) {
  const pp = parentPort
  const handleMessage = async (msg: TranscriptMonitorWorkerMessage): Promise<void> => {
    try {
      switch (msg.type) {
        case "init": {
          monitor = new TranscriptMonitor({
            manifestCache: {
              get: async (cwd: string) => {
                const id = Math.random().toString(36).substring(7)
                return new Promise((resolve) => {
                  const handler = (m: TranscriptMonitorWorkerMessage) => {
                    if (m.type === "manifestResponse" && m.id === id) {
                      pp.off("message", handler)
                      pendingRequests--
                      resolve(m.manifest)
                    }
                  }
                  pp.on("message", handler)
                  pendingRequests++
                  pp.postMessage({
                    type: "getManifest",
                    cwd,
                    id,
                  } satisfies TranscriptMonitorParentMessage)
                })
              },
            },
            cooldownRegistry: {
              checkAndMark: (hookId: string, cooldown: number, cwd: string) => {
                const requestId = Math.random().toString(36).slice(2, 11)
                return new Promise<boolean>((resolve) => {
                  const handler = (m: TranscriptMonitorWorkerMessage) => {
                    if (m.type === "cooldownCheckResponse" && m.requestId === requestId) {
                      pp.off("message", handler)
                      pendingRequests--
                      resolve(m.withinCooldown)
                    }
                  }
                  pp.on("message", handler)
                  pendingRequests++
                  pp.postMessage({
                    type: "checkAndMarkCooldown",
                    requestId,
                    hookId,
                    cooldown,
                    cwd,
                  } satisfies TranscriptMonitorParentMessage)
                })
              },
            },
            projectSettingsCache: {
              get: async (cwd: string) => {
                const id = Math.random().toString(36).substring(7)
                return new Promise((resolve) => {
                  const handler = (m: TranscriptMonitorWorkerMessage) => {
                    if (m.type === "settingsResponse" && m.id === id) {
                      pp.off("message", handler)
                      pendingRequests--
                      resolve({ settings: m.settings })
                    }
                  }
                  pp.on("message", handler)
                  pendingRequests++
                  pp.postMessage({
                    type: "getSettings",
                    cwd,
                    id,
                  } satisfies TranscriptMonitorParentMessage)
                })
              },
            },
          })
          pp.postMessage({ type: "initialized" } satisfies TranscriptMonitorParentMessage)
          publishMemorySnapshot()
          break
        }
        case "pruneOldSessions": {
          if (monitor) {
            monitor.pruneOldSessions(new Set(msg.activeSessions))
          }
          break
        }
        case "getDispatchConcurrencyMetrics": {
          if (monitor) {
            const metrics = monitor.getDispatchConcurrencyMetrics()
            pp.postMessage({
              type: "dispatchConcurrencyMetricsResponse",
              requestId: msg.requestId,
              metrics,
            } satisfies TranscriptMonitorParentMessage)
          }
          break
        }
      }
    } catch (err) {
      stderrLog("transcript-monitor-worker", `Error in worker: ${err}`)
    }
  }
  pp.on("message", (msg: TranscriptMonitorWorkerMessage): void => {
    if (msg.type === "memoryPressure") {
      degraded = msg.degraded
      if (degraded) releaseTranscriptHistory()
      publishMemorySnapshot()
    } else if (msg.type === "checkProject") {
      void checkProject(msg.id, msg.cwd)
    } else {
      void handleMessage(msg)
    }
  })
  setInterval(publishMemorySnapshot, 30_000).unref()
}
