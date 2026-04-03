/**
 * Worker thread host for `BaseFileWatcherRegistry`; recursive dirs use
 * `fs.watch(path, { recursive: true })` via file-watcher-registry.ts.
 */
import { parentPort } from "node:worker_threads"
import type { FileWatcherParentMessage, FileWatcherWorkerMessage } from "../worker-messages.ts"
import { BaseFileWatcherRegistry } from "./file-watcher-registry.ts"

if (!parentPort) {
  process.exit(1)
}

let registry: BaseFileWatcherRegistry | null = null

if (parentPort) {
  const pp = parentPort
  const handleMessage = async (msg: FileWatcherWorkerMessage): Promise<void> => {
    try {
      switch (msg.type) {
        case "init": {
          registry = new BaseFileWatcherRegistry()
          break
        }
        case "register": {
          if (!registry) registry = new BaseFileWatcherRegistry()
          const path = msg.path
          const label = msg.label
          registry.register(
            path,
            label,
            () => {
              pp.postMessage({
                type: "invalidation",
                path,
                label,
              } satisfies FileWatcherParentMessage)
            },
            msg.options
          )
          pp.postMessage({
            type: "status",
            status: registry.status(),
          } satisfies FileWatcherParentMessage)
          break
        }
        case "start": {
          if (!registry) registry = new BaseFileWatcherRegistry()
          await registry.start()
          pp.postMessage({
            type: "status",
            status: registry.status(),
          } satisfies FileWatcherParentMessage)
          pp.postMessage({ type: "started" } satisfies FileWatcherParentMessage)
          break
        }
        case "unregisterByLabelSuffix": {
          if (!registry) {
            break
          }
          registry.unregisterByLabelSuffix(msg.suffix)
          break
        }
        case "close": {
          if (registry) {
            registry.close()
          }
          break
        }
        case "status": {
          const status = registry ? registry.status() : []
          pp.postMessage({ type: "status", status } satisfies FileWatcherParentMessage)
          break
        }
      }
    } catch (err) {
      pp.postMessage({ type: "error", error: String(err) } satisfies FileWatcherParentMessage)
    }
  }
  pp.on("message", (msg: FileWatcherWorkerMessage): void => void handleMessage(msg))
}
