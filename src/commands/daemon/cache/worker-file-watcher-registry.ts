import { Worker } from "node:worker_threads"
import { stderrLog } from "../../../debug.ts"
import type {
  FileWatcherParentMessage,
  FileWatcherStatus,
  FileWatcherWorkerMessage,
} from "../worker-messages.ts"

/** Main-thread facade over `BaseFileWatcherRegistry` in a worker (Bun `fs.watch`, `recursive: true` for trees). */
export class FileWatcherRegistry {
  private worker: Worker
  private callbacks = new Map<string, Set<() => void>>()
  private lastStatus: FileWatcherStatus[] = []
  private closed = false

  constructor() {
    const workerPath = new URL("./file-watcher-worker.ts", import.meta.url).pathname

    this.worker = new Worker(workerPath)

    this.worker.postMessage({ type: "init" } satisfies FileWatcherWorkerMessage)

    this.worker.on("message", (msg: FileWatcherParentMessage) => {
      if (msg.type === "invalidation") {
        const key = `${msg.path}:${msg.label}`
        const cbs = this.callbacks.get(key)
        if (cbs) {
          for (const cb of cbs) {
            try {
              cb()
            } catch (err) {
              stderrLog("FileWatcher", `[daemon] FileWatcher registry callback error: ${err}`)
            }
          }
        }
      } else if (msg.type === "status") {
        this.lastStatus = msg.status
      } else if (msg.type === "error") {
        stderrLog("FileWatcher", `[daemon] FileWatcher worker logic error: ${msg.error}`)
      } else if (msg.type === "started") {
        // Handled by the Promise in start()
      }
    })

    this.worker.on("error", (err) => {
      stderrLog("FileWatcher", `[daemon] FileWatcher worker error: ${err}`)
    })

    this.worker.on("exit", (code) => {
      if (code !== 0) {
        stderrLog("FileWatcher", `[daemon] FileWatcher worker stopped with exit code ${code}`)
      }
    })

    this.worker.unref()
  }

  register(
    path: string,
    label: string,
    callback: () => void,
    options?: { recursive?: boolean; depth?: number }
  ): void {
    const key = `${path}:${label}`
    let cbs = this.callbacks.get(key)
    if (!cbs) {
      cbs = new Set()
      this.callbacks.set(key, cbs)
    }
    cbs.add(callback)

    // Track locally for status() if worker is async
    const existing = this.lastStatus.find((s) => s.path === path && s.label === label)
    if (!existing) {
      this.lastStatus.push({
        path,
        label,
        watching: false,
        watcherCount: 0,
        lastInvalidation: null,
        invalidationCount: 0,
      })
    }

    this.worker.postMessage({
      type: "register",
      path,
      label,
      options,
    } satisfies FileWatcherWorkerMessage)
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      const onMessage = (msg: FileWatcherParentMessage) => {
        if (msg.type === "status") {
          this.lastStatus = msg.status
        } else if (msg.type === "started") {
          this.worker.off("message", onMessage)
          resolve()
        }
      }
      this.worker.on("message", onMessage)
      this.worker.postMessage({ type: "start" } satisfies FileWatcherWorkerMessage)
    })
  }

  unregisterByLabelSuffix(suffix: string): number {
    this.worker.postMessage({
      type: "unregisterByLabelSuffix",
      suffix,
    } satisfies FileWatcherWorkerMessage)

    // Cleanup local callbacks too
    let removed = 0
    for (const key of this.callbacks.keys()) {
      if (key.endsWith(suffix)) {
        this.callbacks.delete(key)
        removed++
      }
    }
    return removed
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.worker.postMessage({ type: "close" } satisfies FileWatcherWorkerMessage)
    } catch {
      // Worker may already be terminated
    }
    void this.worker.terminate()
    this.callbacks.clear()
    for (const s of this.lastStatus) {
      s.watching = false
      s.watcherCount = 0
    }
  }

  status(): FileWatcherStatus[] {
    if (this.closed) return this.lastStatus
    try {
      this.worker.postMessage({ type: "status" } satisfies FileWatcherWorkerMessage)
    } catch {
      // Worker may already be terminated
    }
    return this.lastStatus
  }
}
