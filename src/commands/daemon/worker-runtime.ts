import { normalizeAgentHookPayload } from "../../dispatch/payload-normalize.ts"

export interface NormalizedDispatchPayload {
  cwd: string | null
  sessionId: string | null
  transcriptPath: string | null
  toolName: string | null
  toolInput?: Record<string, unknown>
}

export interface DispatchPayloadWorkerRequest {
  id: string
  kind: "parse-dispatch-payload"
  payloadStr: string
}

export type DispatchPayloadWorkerResponse =
  | {
      id: string
      ok: true
      payload: NormalizedDispatchPayload | null
    }
  | {
      id: string
      ok: false
      error: string
    }

interface WorkerTransport {
  request(payloadStr: string): Promise<NormalizedDispatchPayload | null>
  close(): void
}

function parseDispatchPayloadInThread(payloadStr: string): NormalizedDispatchPayload | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(payloadStr) as Record<string, unknown>
  } catch {
    return null
  }
  normalizeAgentHookPayload(parsed)

  const toolName =
    typeof parsed.tool_name === "string"
      ? parsed.tool_name
      : typeof parsed.toolName === "string"
        ? parsed.toolName
        : null
  const toolInput =
    parsed.tool_input && typeof parsed.tool_input === "object"
      ? (parsed.tool_input as Record<string, unknown>)
      : parsed.toolInput && typeof parsed.toolInput === "object"
        ? (parsed.toolInput as Record<string, unknown>)
        : undefined

  return {
    cwd: typeof parsed.cwd === "string" ? parsed.cwd : null,
    sessionId: typeof parsed.session_id === "string" ? parsed.session_id : null,
    transcriptPath: typeof parsed.transcript_path === "string" ? parsed.transcript_path : null,
    toolName,
    toolInput,
  }
}

class BunWorkerTransport implements WorkerTransport {
  private worker: Worker
  private requestId = 0
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
      this.pending.delete(msg.id)
      if (msg.ok) pending.resolve(msg.payload)
      else pending.reject(new Error(msg.error))
    }
    this.worker.onerror = (event) => {
      const err = event.error ?? new Error(event.message)
      this.failAll(err)
    }
  }

  request(payloadStr: string): Promise<NormalizedDispatchPayload | null> {
    const id = String(++this.requestId)
    const req: DispatchPayloadWorkerRequest = {
      id,
      kind: "parse-dispatch-payload",
      payloadStr,
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.worker.postMessage(req)
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  close(): void {
    this.failAll(new Error("worker closed"))
    this.worker.terminate()
  }

  private failAll(error: unknown): void {
    for (const { reject } of this.pending.values()) reject(error)
    this.pending.clear()
  }
}

function hotPathWorkersEnabled(): boolean {
  return process.env.SWIZ_DAEMON_WORKER_HOTPATH !== "0"
}

/**
 * Worker-backed helper for daemon hot-path compute work.
 *
 * Bun Worker termination is still marked experimental, so this runtime keeps
 * a fallback path in-process and always degrades safely if worker startup or
 * messaging fails.
 */
export class DaemonWorkerRuntime {
  private transport: WorkerTransport | null = null
  private readonly enabled: boolean
  private readonly transportFactory: () => WorkerTransport

  constructor(
    opts: {
      enabled?: boolean
      transportFactory?: () => WorkerTransport
    } = {}
  ) {
    this.enabled = opts.enabled ?? hotPathWorkersEnabled()
    this.transportFactory =
      opts.transportFactory ??
      (() => new BunWorkerTransport(new URL("./hotpath-worker.ts", import.meta.url)))
  }

  async parseDispatchPayload(payloadStr: string): Promise<NormalizedDispatchPayload | null> {
    if (!this.enabled) return this.tryParseInThread(payloadStr)

    const transport = this.ensureTransport()
    if (!transport) return this.tryParseInThread(payloadStr)

    try {
      return await transport.request(payloadStr)
    } catch {
      this.closeTransport()
      return this.tryParseInThread(payloadStr)
    }
  }

  close(): void {
    this.closeTransport()
  }

  private ensureTransport(): WorkerTransport | null {
    if (this.transport) return this.transport
    try {
      this.transport = this.transportFactory()
      return this.transport
    } catch {
      this.transport = null
      return null
    }
  }

  private closeTransport(): void {
    this.transport?.close()
    this.transport = null
  }

  private tryParseInThread(payloadStr: string): NormalizedDispatchPayload | null {
    try {
      return parseDispatchPayloadInThread(payloadStr)
    } catch {
      return null
    }
  }
}
