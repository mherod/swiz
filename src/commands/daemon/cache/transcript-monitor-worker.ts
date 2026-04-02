import { parentPort } from "node:worker_threads"
import { stderrLog } from "../../../debug.ts"
import { TranscriptMonitor } from "./transcript-monitor.ts"

if (!parentPort) {
  process.exit(1)
}

let monitor: TranscriptMonitor | null = null

if (parentPort) {
  const pp = parentPort
  const handleMessage = async (msg: any): Promise<void> => {
    try {
      switch (msg.type) {
        case "init": {
          monitor = new TranscriptMonitor({
            manifestCache: {
              get: async (cwd: string) => {
                const id = Math.random().toString(36).substring(7)
                return new Promise((resolve) => {
                  const handler = (m: any) => {
                    if (m.type === "manifestResponse" && m.id === id) {
                      pp.off("message", handler)
                      resolve(m.manifest)
                    }
                  }
                  pp.on("message", handler)
                  pp.postMessage({ type: "getManifest", cwd, id })
                })
              },
            },
            cooldownRegistry: {
              checkAndMark: (id: string, cooldown: number, cwd: string) => {
                pp.postMessage({ type: "checkAndMarkCooldown", id, cooldown, cwd })
                return false
              },
            },
            projectSettingsCache: {
              get: async (cwd: string) => {
                const id = Math.random().toString(36).substring(7)
                return new Promise((resolve) => {
                  const handler = (m: any) => {
                    if (m.type === "settingsResponse" && m.id === id) {
                      pp.off("message", handler)
                      resolve({ settings: m.settings })
                    }
                  }
                  pp.on("message", handler)
                  pp.postMessage({ type: "getSettings", cwd, id })
                })
              },
            },
          } as any)
          pp.postMessage({ type: "initialized" })
          break
        }
        case "checkProject": {
          if (monitor) {
            await monitor.checkProject(msg.cwd)
          }
          pp.postMessage({ type: "checked", cwd: msg.cwd })
          break
        }
        case "pruneOldSessions": {
          if (monitor) {
            monitor.pruneOldSessions(new Set(msg.activeSessions))
          }
          pp.postMessage({ type: "pruned" })
          break
        }
      }
    } catch (err) {
      stderrLog("transcript-monitor-worker", `Error in worker: ${err}`)
      pp.postMessage({ type: "error", error: String(err) })
    }
  }
  pp.on("message", (msg: any): void => void handleMessage(msg))
}
