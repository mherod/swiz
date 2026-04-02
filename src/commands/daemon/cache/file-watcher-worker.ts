import { parentPort } from "node:worker_threads"
import { BaseFileWatcherRegistry } from "./file-watcher-registry.ts"

if (!parentPort) {
  process.exit(1)
}

let registry: BaseFileWatcherRegistry | null = null

if (parentPort) {
  const pp = parentPort
  const handleMessage = async (msg: any): Promise<void> => {
    try {
      switch (msg.type) {
        case "init": {
          registry = new BaseFileWatcherRegistry(msg.options)
          break
        }
        case "register": {
          if (!registry) registry = new BaseFileWatcherRegistry()
          registry.register(
            msg.path,
            msg.label,
            () => {
              pp.postMessage({ type: "invalidation", path: msg.path, label: msg.label })
            },
            msg.options
          )
          pp.postMessage({ type: "status", status: registry.status() })
          break
        }
        case "start": {
          if (!registry) registry = new BaseFileWatcherRegistry()
          await registry.start()
          pp.postMessage({ type: "status", status: registry.status() })
          pp.postMessage({ type: "started" })
          break
        }
        case "unregisterByLabelSuffix": {
          if (!registry) {
            pp.postMessage({ type: "unregistered", suffix: msg.suffix, count: 0 })
            break
          }
          const count = registry.unregisterByLabelSuffix(msg.suffix)
          pp.postMessage({ type: "unregistered", suffix: msg.suffix, count })
          break
        }
        case "close": {
          if (registry) {
            registry.close()
          }
          pp.postMessage({ type: "closed" })
          break
        }
        case "status": {
          const status = registry ? registry.status() : []
          pp.postMessage({ type: "status", status })
          break
        }
      }
    } catch (err) {
      pp.postMessage({ type: "error", error: String(err) })
    }
  }
  pp.on("message", (msg: any): void => void handleMessage(msg))
}
