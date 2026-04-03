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

const port = parentPort

let registry: BaseFileWatcherRegistry | null = null

const postMessage = (message: FileWatcherParentMessage): void => {
  port.postMessage(message)
}

const postStatus = (): void => {
  postMessage({
    type: "status",
    status: registry ? registry.status() : [],
  })
}

const postError = (error: unknown): void => {
  postMessage({ type: "error", error: String(error) })
}

const createRegistry = (): BaseFileWatcherRegistry => {
  registry = new BaseFileWatcherRegistry()
  return registry
}

const getOrCreateRegistry = (): BaseFileWatcherRegistry => {
  return registry ?? createRegistry()
}

const postInvalidation = (path: string, label: string): void => {
  postMessage({ type: "invalidation", path, label })
}

const handleRegister = (msg: Extract<FileWatcherWorkerMessage, { type: "register" }>): void => {
  const activeRegistry = getOrCreateRegistry()
  const { path, label, options } = msg

  activeRegistry.register(path, label, () => postInvalidation(path, label), options)
  postStatus()
}

const handleStart = async (): Promise<void> => {
  const activeRegistry = getOrCreateRegistry()

  await activeRegistry.start()
  postStatus()
  postMessage({ type: "started" })
}

const handleMessage = async (msg: FileWatcherWorkerMessage): Promise<void> => {
  try {
    switch (msg.type) {
      case "init": {
        createRegistry()
        break
      }
      case "register": {
        handleRegister(msg)
        break
      }
      case "start": {
        await handleStart()
        break
      }
      case "unregisterByLabelSuffix": {
        registry?.unregisterByLabelSuffix(msg.suffix)
        break
      }
      case "close": {
        registry?.close()
        break
      }
      case "status": {
        postStatus()
        break
      }
    }
  } catch (err) {
    postError(err)
  }
}

port.on("message", (msg: FileWatcherWorkerMessage): void => void handleMessage(msg))
