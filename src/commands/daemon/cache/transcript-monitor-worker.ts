import { parentPort } from "node:worker_threads"
import { stderrLog } from "../../../debug.ts"
import type {
  TranscriptMonitorParentMessage,
  TranscriptMonitorWorkerMessage,
} from "../worker-messages.ts"
import { TranscriptMonitor } from "./transcript-monitor.ts"

if (!parentPort) {
  process.exit(1)
}

let monitor: TranscriptMonitor | null = null

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
                      resolve(m.manifest)
                    }
                  }
                  pp.on("message", handler)
                  pp.postMessage({
                    type: "getManifest",
                    cwd,
                    id,
                  } satisfies TranscriptMonitorParentMessage)
                })
              },
            },
            cooldownRegistry: {
              checkAndMark: (id: string, cooldown: number, cwd: string) => {
                pp.postMessage({
                  type: "checkAndMarkCooldown",
                  id,
                  cooldown,
                  cwd,
                } satisfies TranscriptMonitorParentMessage)
                return false
              },
            },
            projectSettingsCache: {
              get: async (cwd: string) => {
                const id = Math.random().toString(36).substring(7)
                return new Promise((resolve) => {
                  const handler = (m: TranscriptMonitorWorkerMessage) => {
                    if (m.type === "settingsResponse" && m.id === id) {
                      pp.off("message", handler)
                      resolve({ settings: m.settings })
                    }
                  }
                  pp.on("message", handler)
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
          break
        }
        case "checkProject": {
          if (monitor) {
            await monitor.checkProject(msg.cwd)
          }
          break
        }
        case "pruneOldSessions": {
          if (monitor) {
            monitor.pruneOldSessions(new Set(msg.activeSessions))
          }
          break
        }
      }
    } catch (err) {
      stderrLog("transcript-monitor-worker", `Error in worker: ${err}`)
    }
  }
  pp.on("message", (msg: TranscriptMonitorWorkerMessage): void => void handleMessage(msg))
}
