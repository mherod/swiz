import {
  PendingRequestRegistry,
  RpcFailure,
  type RpcScheduler,
  validateRpcLimit,
} from "./cache/worker-rpc.ts"
import {
  type DispatchPayloadWorkerRequest,
  type DispatchPayloadWorkerResponse,
  type NormalizedDispatchPayload,
  parseDispatchPayload,
} from "./dispatch-payload.ts"

export {
  type DispatchPayloadWorkerRequest,
  type DispatchPayloadWorkerResponse,
  type NormalizedDispatchPayload,
  normalizeParsedDispatchPayload,
} from "./dispatch-payload.ts"

export interface DispatchPayloadRequestOptions {
  signal?: AbortSignal
  /** Remaining caller budget; bounded by the runtime's own parse deadline. */
  timeoutMs?: number
}

interface WorkerTransport {
  request(payloadStr: string, signal?: AbortSignal): Promise<NormalizedDispatchPayload | null>
  close(): void
}

class BunWorkerTransport implements WorkerTransport {
  private worker: Worker
  private requestId = 0
  private closed = false
  /** Wire correlation only; the runtime registry owns capacity and deadlines. */
  private pending = new Map<
    string,
    {
      resolve: (value: NormalizedDispatchPayload | null) => void
      reject: (reason?: unknown) => void
    }
  >()

  constructor(workerUrl: URL) {
    this.worker = new Worker(workerUrl, { type: "module" })
    this.worker.onmessage = (event: MessageEvent<DispatchPayloadWorkerResponse>) => {
      const msg = event.data
      const pending = this.pending.get(msg.id)
      if (!pending) return
      if (msg.ok) pending.resolve(msg.payload)
      else pending.reject(new RpcFailure("REMOTE", msg.error))
    }
    this.worker.onerror = () => this.failAll(new RpcFailure("WORKER_EXIT"))
  }

  request(payloadStr: string, signal?: AbortSignal): Promise<NormalizedDispatchPayload | null> {
    if (this.closed) return Promise.reject(new RpcFailure("CLOSED"))
    if (signal?.aborted) return Promise.reject(new RpcFailure("ABORTED"))
    const id = String(++this.requestId)
    const req: DispatchPayloadWorkerRequest = {
      id,
      kind: "parse-dispatch-payload",
      payloadStr,
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.pending.delete(id)
        signal?.removeEventListener("abort", abort)
      }
      const abort = () => {
        cleanup()
        reject(new RpcFailure("ABORTED"))
      }
      this.pending.set(id, {
        resolve: (value) => {
          cleanup()
          resolve(value)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
      })
      signal?.addEventListener("abort", abort, { once: true })
      try {
        this.worker.postMessage(req)
      } catch (error) {
        this.pending.get(id)?.reject(error)
      }
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.failAll(new RpcFailure("CLOSED"))
    this.worker.terminate()
  }

  private failAll(error: unknown): void {
    for (const { reject } of this.pending.values()) reject(error)
  }
}

interface TransportGeneration {
  transport: WorkerTransport
  requests: PendingRequestRegistry
}

function hotPathWorkersEnabled(): boolean {
  return process.env.SWIZ_DAEMON_WORKER_HOTPATH !== "0"
}

/** Worker-backed payload parsing with bounded waits and local recovery. */
export class DaemonWorkerRuntime {
  private generation: TransportGeneration | null = null
  private closed = false
  private readonly enabled: boolean
  private readonly transportFactory: () => WorkerTransport
  private readonly defaultTimeoutMs: number
  private readonly maxPending: number
  private readonly schedule?: RpcScheduler

  constructor(
    opts: {
      enabled?: boolean
      transportFactory?: () => WorkerTransport
      defaultTimeoutMs?: number
      maxPending?: number
      schedule?: RpcScheduler
    } = {}
  ) {
    this.enabled = opts.enabled ?? hotPathWorkersEnabled()
    this.defaultTimeoutMs = validateRpcLimit(opts.defaultTimeoutMs ?? 1_000)
    this.maxPending = validateRpcLimit(opts.maxPending ?? 128)
    this.schedule = opts.schedule
    this.transportFactory =
      opts.transportFactory ??
      (() => new BunWorkerTransport(new URL("./hotpath-worker.ts", import.meta.url)))
  }

  async parseDispatchPayload(
    payloadStr: string,
    options: DispatchPayloadRequestOptions = {}
  ): Promise<NormalizedDispatchPayload | null> {
    const timeoutMs = this.resolveRequestBudget(options)
    if (timeoutMs === null) return null
    if (!this.enabled) return parseDispatchPayload(payloadStr)

    const generation = this.ensureTransport()
    if (!generation) return parseDispatchPayload(payloadStr)
    const { transport, requests } = generation
    const transportAbort = new AbortController()
    try {
      return await requests.request<NormalizedDispatchPayload | null>(
        (id) => {
          void transport.request(payloadStr, transportAbort.signal).then(
            (payload) => requests.resolve(id, payload),
            () => requests.reject(id, new RpcFailure("REMOTE"))
          )
        },
        { signal: options.signal, timeoutMs, label: "parse-dispatch-payload" }
      )
    } catch (error) {
      return this.recoverPayload(error, generation, payloadStr, options.signal)
    } finally {
      transportAbort.abort()
    }
  }

  private resolveRequestBudget(options: DispatchPayloadRequestOptions): number | null {
    if (this.closed || options.signal?.aborted || (options.timeoutMs ?? 1) <= 0) return null
    return Math.max(
      1,
      Math.floor(Math.min(this.defaultTimeoutMs, options.timeoutMs ?? this.defaultTimeoutMs))
    )
  }

  private recoverPayload(
    error: unknown,
    generation: TransportGeneration,
    payloadStr: string,
    signal?: AbortSignal
  ): NormalizedDispatchPayload | null {
    if (this.closed || signal?.aborted) return null
    if (!(error instanceof RpcFailure) || !["CAPACITY", "CLOSED"].includes(error.code)) {
      this.closeTransport(generation)
    }
    return parseDispatchPayload(payloadStr)
  }

  close(): void {
    this.closed = true
    if (this.generation) this.closeTransport(this.generation)
  }

  private ensureTransport(): TransportGeneration | null {
    if (this.generation) return this.generation
    try {
      this.generation = {
        transport: this.transportFactory(),
        requests: new PendingRequestRegistry({
          defaultTimeoutMs: this.defaultTimeoutMs,
          maxPending: this.maxPending,
          schedule: this.schedule,
        }),
      }
      return this.generation
    } catch {
      return null
    }
  }

  private closeTransport(generation: TransportGeneration): void {
    if (this.generation !== generation) return
    // Detach before settling requests: recovery can create a new generation.
    this.generation = null
    generation.requests.close()
    try {
      generation.transport.close()
    } catch {
      // A broken transport must not prevent settlement or local recovery.
    }
  }
}
