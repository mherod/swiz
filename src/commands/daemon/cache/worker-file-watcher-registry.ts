import { Worker } from "node:worker_threads"
import { stderrLog } from "../../../debug.ts"
import type {
  FileWatcherParentMessage,
  FileWatcherStatus,
  FileWatcherWorkerMessage,
} from "../worker-messages.ts"
import type { WatchRegistrationOptions } from "./file-watcher-registry.ts"
import { PendingRequestRegistry, RpcFailure, type RpcScheduler } from "./worker-rpc.ts"

interface FileWatcherRegistryOptions {
  workerFactory?: () => Pick<Worker, "on" | "postMessage" | "terminate" | "unref">
  schedule?: RpcScheduler
}

/** Main-thread facade over `BaseFileWatcherRegistry` in a worker (Bun `fs.watch`, `recursive: true` for trees). */
export class FileWatcherRegistry {
  private worker: Pick<Worker, "on" | "postMessage" | "terminate" | "unref">
  private callbacks = new Map<string, Set<() => void>>()
  private rpc: PendingRequestRegistry
  private starting: Promise<void> | null = null
  private closed = false
  private unavailable = false

  constructor(options: FileWatcherRegistryOptions = {}) {
    this.rpc = new PendingRequestRegistry({ maxPending: 32, schedule: options.schedule })
    const workerPath = new URL("./file-watcher-worker.ts", import.meta.url).pathname

    this.worker = options.workerFactory?.() ?? new Worker(workerPath)

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
        this.rpc.resolve(msg.id, msg.status)
      } else if (msg.type === "error") {
        if (msg.id) this.rpc.reject(msg.id, new RpcFailure("REMOTE"))
        stderrLog("FileWatcher", `[daemon] FileWatcher worker logic error: ${msg.error}`)
      } else if (msg.type === "started") {
        this.rpc.resolve(msg.id, undefined)
      }
    })

    this.worker.on("error", (err) => {
      this.failWorker()
      stderrLog("FileWatcher", `[daemon] FileWatcher worker error: ${err}`)
    })

    this.worker.on("exit", (code) => {
      this.failWorker()
      if (code !== 0) {
        stderrLog("FileWatcher", `[daemon] FileWatcher worker stopped with exit code ${code}`)
      }
    })

    this.worker.unref()
    this.worker.postMessage({ type: "init" } satisfies FileWatcherWorkerMessage)
  }

  private failWorker(): void {
    this.unavailable = true
    this.rpc.rejectAll(new RpcFailure("WORKER_EXIT", "File watcher worker exited"))
    this.callbacks.clear()
  }

  register(
    path: string,
    label: string,
    callback: () => void,
    options?: WatchRegistrationOptions
  ): void {
    if (this.closed || this.unavailable) return
    const key = `${path}:${label}`
    let cbs = this.callbacks.get(key)
    if (!cbs) {
      cbs = new Set()
      this.callbacks.set(key, cbs)
    }
    cbs.add(callback)

    this.worker.postMessage({
      type: "register",
      path,
      label,
      options,
    } satisfies FileWatcherWorkerMessage)
  }

  start(): Promise<void> {
    if (this.starting) return this.starting
    this.starting = this.request<void>("start").finally(() => {
      this.starting = null
    })
    return this.starting
  }

  unregisterByLabelSuffix(suffix: string): number {
    if (this.closed || this.unavailable) return 0
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
    this.rpc.close()
    try {
      this.worker.postMessage({ type: "close" } satisfies FileWatcherWorkerMessage)
    } catch {
      // Worker may already be terminated
    }
    void this.worker.terminate().catch(() => {})
    this.callbacks.clear()
  }

  /** Sample in the worker after this request; never return an earlier cached reading. */
  status(): Promise<FileWatcherStatus[]> {
    return this.request<FileWatcherStatus[]>("status", 1_000)
  }

  private request<T>(type: "status" | "start", timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(new RpcFailure("CLOSED", "File watcher closed"))
    if (this.unavailable) {
      return Promise.reject(new RpcFailure("WORKER_EXIT", "File watcher worker exited"))
    }
    return this.rpc.request<T>(
      (id) => this.worker.postMessage({ type, id } satisfies FileWatcherWorkerMessage),
      { timeoutMs, label: `file watcher ${type}` }
    )
  }
}
