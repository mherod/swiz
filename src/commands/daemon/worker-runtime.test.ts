import { describe, expect, test } from "bun:test"
import { workerClock } from "./cache/test-utils/rpc.ts"
import { type NormalizedDispatchPayload, parseDispatchPayload } from "./dispatch-payload.ts"
import { DaemonWorkerRuntime } from "./worker-runtime.ts"

const payloadStr = JSON.stringify({ cwd: "/repo", session_id: "session-1", tool_name: "Read" })
const normalized = parseDispatchPayload(payloadStr)

class ControlledTransport {
  requests: Array<{
    signal?: AbortSignal
    resolve: (payload: NormalizedDispatchPayload | null) => void
    reject: (error: Error) => void
  }> = []
  closeCount = 0
  onClose?: () => void

  request(_payloadStr: string, signal?: AbortSignal): Promise<NormalizedDispatchPayload | null> {
    return new Promise((resolve, reject) => this.requests.push({ signal, resolve, reject }))
  }

  close(): void {
    this.closeCount++
    this.onClose?.()
  }
}

function fixture(options: { maxPending?: number } = {}) {
  const clock = workerClock()
  const transport = new ControlledTransport()
  const runtime = new DaemonWorkerRuntime({
    enabled: true,
    defaultTimeoutMs: 100,
    maxPending: options.maxPending,
    schedule: clock.schedule,
    transportFactory: () => transport,
  })
  return { clock, transport, runtime }
}

describe("DaemonWorkerRuntime request lifetime", () => {
  test("recovers a silent transport at its deadline and cancels its request", async () => {
    const { clock, transport, runtime } = fixture()
    const result = runtime.parseDispatchPayload(payloadStr)
    expect(clock.callbacks.size).toBe(1)
    clock.advance(100)

    expect(await result).toEqual(normalized)
    expect(transport.closeCount).toBe(1)
    expect(transport.requests[0]!.signal?.aborted).toBe(true)
    expect(clock.callbacks.size).toBe(0)
    runtime.close()
  })

  test("uses the remaining caller budget when it is shorter than the parse deadline", async () => {
    const { clock, transport, runtime } = fixture()
    const result = runtime.parseDispatchPayload(payloadStr, { timeoutMs: 10 })
    clock.advance(9)
    expect(transport.closeCount).toBe(0)
    clock.advance(1)

    expect(await result).toEqual(normalized)
    expect(transport.closeCount).toBe(1)
    expect(clock.callbacks.size).toBe(0)
    runtime.close()
  })

  test("does not extend the parse deadline to a longer caller budget", async () => {
    const { clock, runtime } = fixture()
    const result = runtime.parseDispatchPayload(payloadStr, { timeoutMs: 1_000 })
    clock.advance(100)
    expect(await result).toEqual(normalized)
    runtime.close()
  })

  test("falls back at capacity without sending or closing healthy outstanding work", async () => {
    const { clock, transport, runtime } = fixture({ maxPending: 1 })
    const first = runtime.parseDispatchPayload(payloadStr)
    expect(await runtime.parseDispatchPayload(payloadStr)).toEqual(normalized)
    expect(transport.requests).toHaveLength(1)
    expect(transport.closeCount).toBe(0)
    expect(clock.callbacks.size).toBe(1)

    transport.requests[0]!.resolve(normalized)
    expect(await first).toEqual(normalized)
    expect(clock.callbacks.size).toBe(0)
    runtime.close()
  })

  test("cancels one caller without restarting the worker or disrupting another caller", async () => {
    const { clock, transport, runtime } = fixture()
    const controller = new AbortController()
    const cancelled = runtime.parseDispatchPayload(payloadStr, { signal: controller.signal })
    const healthy = runtime.parseDispatchPayload(payloadStr)
    controller.abort()

    expect(await cancelled).toBeNull()
    expect(transport.requests[0]!.signal?.aborted).toBe(true)
    expect(transport.requests[1]!.signal?.aborted).toBe(false)
    expect(transport.closeCount).toBe(0)
    expect(clock.callbacks.size).toBe(1)
    transport.requests[1]!.resolve(normalized)
    expect(await healthy).toEqual(normalized)
    expect(clock.callbacks.size).toBe(0)
    runtime.close()
  })

  test("does no work for already-cancelled callers or exhausted budgets", async () => {
    const { clock, transport, runtime } = fixture()
    const controller = new AbortController()
    controller.abort()
    expect(await runtime.parseDispatchPayload(payloadStr, { signal: controller.signal })).toBeNull()
    expect(await runtime.parseDispatchPayload(payloadStr, { timeoutMs: 0 })).toBeNull()
    expect(transport.requests).toHaveLength(0)
    expect(clock.callbacks.size).toBe(0)
    runtime.close()
  })

  test("close settles all callers and prevents later requests from restarting", async () => {
    const { clock, transport, runtime } = fixture()
    const first = runtime.parseDispatchPayload(payloadStr)
    const second = runtime.parseDispatchPayload(payloadStr)
    runtime.close()

    expect(await first).toBeNull()
    expect(await second).toBeNull()
    expect(await runtime.parseDispatchPayload(payloadStr)).toBeNull()
    expect(transport.requests).toHaveLength(2)
    expect(transport.requests.every((request) => request.signal?.aborted)).toBe(true)
    expect(clock.callbacks.size).toBe(0)
    runtime.close()
    expect(transport.closeCount).toBe(1)
  })

  test("ignores late replies after recovery without settling replacement requests", async () => {
    const clock = workerClock()
    const oldTransport = new ControlledTransport()
    const replacement = new ControlledTransport()
    let created = 0
    const runtime = new DaemonWorkerRuntime({
      enabled: true,
      defaultTimeoutMs: 100,
      schedule: clock.schedule,
      transportFactory: () => (created++ === 0 ? oldTransport : replacement),
    })
    const first = runtime.parseDispatchPayload(payloadStr)
    clock.advance(100)
    expect(await first).toEqual(normalized)

    const next = runtime.parseDispatchPayload(payloadStr)
    oldTransport.requests[0]!.resolve({ ...normalized!, cwd: "/wrong-repo" })
    await Promise.resolve()
    expect(replacement.closeCount).toBe(0)
    expect(clock.callbacks.size).toBe(1)
    replacement.requests[0]!.resolve(normalized)
    expect(await next).toEqual(normalized)
    expect(clock.callbacks.size).toBe(0)
    runtime.close()
  })

  test("concurrent failures from an old generation cannot close its replacement", async () => {
    const clock = workerClock()
    const oldTransport = new ControlledTransport()
    const replacement = new ControlledTransport()
    let created = 0
    const runtime = new DaemonWorkerRuntime({
      enabled: true,
      schedule: clock.schedule,
      transportFactory: () => (created++ === 0 ? oldTransport : replacement),
    })
    let next: Promise<NormalizedDispatchPayload | null> | undefined
    oldTransport.onClose = () => {
      next = runtime.parseDispatchPayload(payloadStr)
    }
    const first = runtime.parseDispatchPayload(payloadStr)
    const second = runtime.parseDispatchPayload(payloadStr)
    for (const request of oldTransport.requests) request.reject(new Error("transport failed"))

    expect(await first).toEqual(normalized)
    expect(await second).toEqual(normalized)
    expect(created).toBe(2)
    expect(replacement.closeCount).toBe(0)
    expect(clock.callbacks.size).toBe(1)
    replacement.requests[0]!.resolve(normalized)
    expect(await next).toEqual(normalized)
    runtime.close()
    expect(clock.callbacks.size).toBe(0)
  })

  test("recovers from synchronous request and close failures", async () => {
    const clock = workerClock()
    const runtime = new DaemonWorkerRuntime({
      enabled: true,
      schedule: clock.schedule,
      transportFactory: () => ({
        request: () => {
          throw new Error("cannot send")
        },
        close: () => {
          throw new Error("already gone")
        },
      }),
    })
    expect(await runtime.parseDispatchPayload(payloadStr)).toEqual(normalized)
    expect(clock.callbacks.size).toBe(0)
    runtime.close()
  })
})

describe("shared dispatch payload normalization", () => {
  test("worker results and local fallback preserve agent field normalization", async () => {
    const worker = new DaemonWorkerRuntime({
      enabled: true,
      transportFactory: () => ({
        request: async (payload) => parseDispatchPayload(payload),
        close: () => {},
      }),
    })
    const local = new DaemonWorkerRuntime({ enabled: false })
    const failed = new DaemonWorkerRuntime({
      enabled: true,
      transportFactory: () => {
        throw new Error("unavailable")
      },
    })
    const payloads = [
      {
        conversation_id: "cursor-session",
        workspace_roots: ["/workspace"],
        cwd: "/home/user/.cursor",
        command: " ls ",
      },
      { ...JSON.parse(payloadStr), agent_id: "child", transcript_path: "/session.jsonl" },
      { tool_name: "exec_command", tool_input: { cmd: "pwd" } },
      { toolName: "ReadFile", toolInput: { path: "/workspace/file.ts" } },
    ]
    for (const payload of payloads) {
      const input = JSON.stringify(payload)
      const expected = parseDispatchPayload(input)
      expect(await worker.parseDispatchPayload(input)).toEqual(expected)
      expect(await local.parseDispatchPayload(input)).toEqual(expected)
      expect(await failed.parseDispatchPayload(input)).toEqual(expected)
    }
    expect(await local.parseDispatchPayload(JSON.stringify(payloads[0]))).toMatchObject({
      cwd: "/workspace",
      sessionId: "cursor-session",
      toolName: "Bash",
      toolInput: { command: "ls" },
    })
    worker.close()
    local.close()
    failed.close()
  })

  test("returns null for malformed JSON and null on both execution paths", async () => {
    const local = new DaemonWorkerRuntime({ enabled: false })
    const worker = new DaemonWorkerRuntime({
      enabled: true,
      transportFactory: () => ({
        request: async (payload) => parseDispatchPayload(payload),
        close: () => {},
      }),
    })
    for (const payload of ["not json", "null", ""]) {
      expect(await worker.parseDispatchPayload(payload)).toBeNull()
      expect(await local.parseDispatchPayload(payload)).toBeNull()
    }
    worker.close()
    local.close()
  })
})
