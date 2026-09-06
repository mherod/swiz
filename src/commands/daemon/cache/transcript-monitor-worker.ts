import { parentPort } from "node:worker_threads"
import { stderrLog } from "../../../debug.ts"
import type { HookGroup } from "../../../hook-types.ts"
import type { ProjectSwizSettings } from "../../../settings/types.ts"
import { getFileCacheMemoryStats } from "../../../utils/file-cache.ts"
import { releaseTranscriptHistory } from "../memory-relief.ts"
import type {
  TranscriptMonitorParentMessage,
  TranscriptMonitorWorkerMessage,
} from "../worker-messages.ts"
import { TranscriptMonitor } from "./transcript-monitor.ts"
import { PendingRequestRegistry } from "./worker-rpc.ts"

if (!parentPort) {
  process.exit(1)
}

let monitor: TranscriptMonitor | null = null
let degraded = false
let activeChecks = 0

/**
 * Worker-to-parent service requests. One registry replaces the per-request `on("message")`
 * listeners this file used to attach: those were removed only on a matching reply, so a parent
 * that never answered leaked a listener and left `pendingRequests` permanently incremented.
 */
const parentRequests = new PendingRequestRegistry({ defaultTimeoutMs: 10_000 })

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
      pendingRequests: parentRequests.pendingCount,
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

  /**
   * Send a request to the parent and await its reply under a bounded deadline.
   * The registry owns settlement, so no listener is attached per request.
   */
  const requestFromParent = <T>(
    prefix: string,
    build: (id: string) => TranscriptMonitorParentMessage
  ): Promise<T> => {
    const id = parentRequests.nextId(prefix)
    const promise = parentRequests.register<T>(id, { label: prefix })
    pp.postMessage(build(id))
    return promise
  }

  /**
   * Route a reply to its waiting request; an `error` field rejects rather than strands it.
   * Returns true for every reply type — a reply that arrives after its deadline has no waiter
   * left and is simply dropped here rather than falling through to the command handler.
   */
  const routeParentReply = (msg: TranscriptMonitorWorkerMessage): boolean => {
    switch (msg.type) {
      case "manifestResponse":
        if (msg.error) parentRequests.reject(msg.id, new Error(msg.error))
        else parentRequests.resolve(msg.id, msg.manifest)
        return true
      case "settingsResponse":
        if (msg.error) parentRequests.reject(msg.id, new Error(msg.error))
        else parentRequests.resolve(msg.id, msg.settings)
        return true
      case "cooldownCheckResponse":
        if (msg.error) parentRequests.reject(msg.requestId, new Error(msg.error))
        else parentRequests.resolve(msg.requestId, msg.withinCooldown)
        return true
      default:
        return false
    }
  }

  const handleMessage = async (msg: TranscriptMonitorWorkerMessage): Promise<void> => {
    try {
      switch (msg.type) {
        case "init": {
          try {
            monitor = new TranscriptMonitor({
              manifestCache: {
                get: (cwd: string) =>
                  requestFromParent<HookGroup[]>("manifest", (id) => ({
                    type: "getManifest",
                    cwd,
                    id,
                  })),
              },
              cooldownRegistry: {
                checkAndMark: (hookId: string, cooldown: number, cwd: string) =>
                  requestFromParent<boolean>("cooldown", (requestId) => ({
                    type: "checkAndMarkCooldown",
                    requestId,
                    hookId,
                    cooldown,
                    cwd,
                  })),
              },
              projectSettingsCache: {
                get: async (cwd: string) => ({
                  settings: await requestFromParent<ProjectSwizSettings | null>(
                    "settings",
                    (id) => ({ type: "getSettings", cwd, id })
                  ),
                }),
              },
            })
            pp.postMessage({ type: "initialized" } satisfies TranscriptMonitorParentMessage)
          } catch (err) {
            // Report the failure instead of leaving the parent's init deadline to expire.
            monitor = null
            pp.postMessage({
              type: "initialized",
              error: err instanceof Error ? err.message : String(err),
            } satisfies TranscriptMonitorParentMessage)
          }
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
          // Always reply. Staying silent when there is no monitor strands the parent's await,
          // which holds its periodic-monitor guard and suppresses every later check.
          if (monitor) {
            pp.postMessage({
              type: "dispatchConcurrencyMetricsResponse",
              requestId: msg.requestId,
              metrics: monitor.getDispatchConcurrencyMetrics(),
            } satisfies TranscriptMonitorParentMessage)
          } else {
            pp.postMessage({
              type: "dispatchConcurrencyMetricsResponse",
              requestId: msg.requestId,
              metrics: { active: 0, queued: 0, maxConcurrent: 0 },
              error: "Transcript monitor is not initialized",
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
    if (routeParentReply(msg)) return
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
