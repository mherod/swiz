import { afterEach, expect, test } from "bun:test"
import { createMetrics, serializeMetrics } from "./metrics.ts"
import { FakeTranscriptWorker, flushRpc, workerClock } from "./test-utils/rpc.ts"
import {
  type TranscriptWorker,
  transcriptWorkerOptions,
  WorkerTranscriptMonitor,
  type WorkerTranscriptMonitorOptions,
} from "./worker-transcript-monitor.ts"

const monitors: WorkerTranscriptMonitor[] = []
afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.terminate()
})

function harness(options: WorkerTranscriptMonitorOptions = {}) {
  const clock = workerClock()
  const workers: FakeTranscriptWorker[] = []
  const monitor = new WorkerTranscriptMonitor(
    {
      manifestCache: {
        get: async () => {
          throw new Error("private manifest path")
        },
      },
      projectSettingsCache: {
        get: async () => {
          throw new Error("private settings")
        },
      },
      cooldownRegistry: {
        checkAndMark: () => {
          throw new Error("private cooldown")
        },
      },
    },
    {
      schedule: clock.schedule,
      workerFactory: () => {
        const worker = new FakeTranscriptWorker()
        workers.push(worker)
        return worker as unknown as TranscriptWorker
      },
      ...options,
    }
  )
  monitors.push(monitor)
  return { clock, workers, monitor }
}

test("startup deadline rejects waiters and a later trigger starts one replacement", async () => {
  const { clock, workers, monitor } = harness()
  const initial = monitor.checkProject("/project").catch((error) => error)
  clock.advance(15_000)
  expect(await initial).toBeInstanceOf(Error)
  expect(monitor.getRpcMetrics()).toMatchObject({ pending: 0, timeouts: 1, restarts: 0 })
  expect(workers[0]!.listenerCount("message")).toBe(0)
  const next = monitor.checkProject("/next")
  clock.advance(250)
  workers[1]!.initialize()
  await flushRpc()
  const check = workers[1]!.sent.find((msg) => msg.type === "checkProject")!
  if (check.type !== "checkProject") throw new Error("Missing check")
  workers[1]!.reply({ type: "checkProjectResponse", id: check.id, cwd: check.cwd, durationMs: 12 })
  await next
  expect(monitor.getRpcMetrics().restarts).toBe(1)
  expect(monitor.getCoordinatorMetrics().activeChecks).toBe(0)
})

test("stalled metrics time out, detach listeners, and expose live failure metrics", async () => {
  const { clock, workers, monitor } = harness()
  workers[0]!.initialize()
  await flushRpc()
  const pending = monitor.getDispatchConcurrencyMetrics().catch((error) => error)
  await flushRpc()
  clock.advance(15_000)
  expect(await pending).toMatchObject({ code: "TIMEOUT" })
  expect(workers[0]!.terminated).toBe(true)
  expect(workers[0]!.eventNames()).toEqual([])
  const metrics = createMetrics()
  Object.defineProperty(metrics, "transcriptMonitorRpc", { get: () => monitor.getRpcMetrics() })
  expect(serializeMetrics(metrics).transcriptMonitorRpc).toMatchObject({ pending: 0, timeouts: 1 })
  expect(clock.callbacks.size).toBe(0)
})

test("a timed-out check releases queued projects and ignores the retired worker", async () => {
  const { clock, workers, monitor } = harness({ maxConcurrentChecks: 1 })
  const old = workers[0]!
  old.initialize()
  await flushRpc()
  const stalled = monitor.checkProject("/stalled").catch((error) => error)
  const queued = monitor.checkProject("/queued")
  await flushRpc()
  clock.advance(60_000)
  expect(await stalled).toBeInstanceOf(Error)
  clock.advance(250)
  const replacement = workers[1]!
  replacement.initialize()
  await flushRpc()
  const check = replacement.sent.find((msg) => msg.type === "checkProject")!
  if (check.type !== "checkProject") throw new Error("Missing check")
  old.reply({ type: "checkProjectResponse", id: check.id, cwd: "/wrong", durationMs: 999 })
  expect(monitor.getCoordinatorMetrics().activeChecks).toBe(1)
  replacement.reply({ type: "checkProjectResponse", id: check.id, cwd: check.cwd, durationMs: 10 })
  await queued
  expect(check.cwd).toBe("/queued")
  expect(monitor.getCoordinatorMetrics()).toMatchObject({ activeChecks: 0, queuedChecks: 0 })
  expect(monitor.getRpcMetrics()).toMatchObject({ pending: 0, restarts: 1 })
})

for (const event of ["error", "exit"] as const) {
  test(`worker ${event} rejects metrics and checks without closing future coordination`, async () => {
    const { workers, monitor } = harness()
    workers[0]!.initialize()
    await flushRpc()
    const check = monitor.checkProject("/project").catch((error) => error)
    const metrics = monitor.getDispatchConcurrencyMetrics().catch((error) => error)
    workers[0]!.emit(event, event === "error" ? new Error("crash") : 1)
    expect(await check).toBeInstanceOf(Error)
    expect(await metrics).toMatchObject({ code: "WORKER_EXIT" })
    expect(monitor.getCoordinatorMetrics()).toMatchObject({ activeChecks: 0, queuedChecks: 0 })
    expect(monitor.getRpcMetrics().pending).toBe(0)
    expect(workers[0]!.eventNames()).toEqual([])
  })
}

test("abort and shutdown settle requests and never send obsolete messages", async () => {
  const { workers, monitor, clock } = harness()
  const controller = new AbortController()
  const cancelled = monitor.getDispatchConcurrencyMetrics(controller.signal).catch((error) => error)
  controller.abort()
  expect(await cancelled).toMatchObject({ code: "ABORTED" })
  workers[0]!.initialize()
  await flushRpc()
  expect(workers[0]!.sent.some((msg) => msg.type === "getDispatchConcurrencyMetrics")).toBe(false)
  const check = monitor.checkProject("/project").catch((error) => error)
  const metrics = monitor.getDispatchConcurrencyMetrics().catch((error) => error)
  monitor.terminate()
  expect(await check).toBeInstanceOf(Error)
  expect(await metrics).toMatchObject({ code: "CLOSED" })
  clock.advance(10_000)
  expect(workers).toHaveLength(1)
  expect(clock.callbacks.size).toBe(0)
  expect(monitor.getRpcMetrics().pending).toBe(0)
})

test("parent service rejection produces structured content-free error replies", async () => {
  const { workers, monitor } = harness()
  const worker = workers[0]!
  worker.initialize()
  await flushRpc()
  worker.reply({ type: "getManifest", id: "m", cwd: "/private" })
  worker.reply({ type: "getSettings", id: "s", cwd: "/private" })
  worker.reply({
    type: "checkAndMarkCooldown",
    requestId: "c",
    hookId: "hook",
    cooldown: 1,
    cwd: "/private",
  })
  await flushRpc()
  expect(worker.sent.filter((msg) => msg.type === "rpcError")).toEqual([
    { type: "rpcError", id: "m", code: "REMOTE" },
    { type: "rpcError", id: "s", code: "REMOTE" },
    { type: "rpcError", id: "c", code: "REMOTE" },
  ])
  expect(monitor.getRpcMetrics()).toMatchObject({ pending: 0, serving: 0, failures: 3 })
})

test("request storms retain one message listener and a bounded pending registry", async () => {
  const { monitor, workers } = harness({ maxPending: 8 })
  workers[0]!.initialize()
  await flushRpc()
  const requests = Array.from({ length: 1000 }, () =>
    monitor.getDispatchConcurrencyMetrics().catch((error) => error)
  )
  expect(monitor.getRpcMetrics().pending).toBe(8)
  expect(workers[0]!.listenerCount("message")).toBe(1)
  monitor.terminate()
  const results = await Promise.all(requests)
  expect(
    results.filter(
      (result) => result instanceof Error && "code" in result && result.code === "CAPACITY"
    )
  ).toHaveLength(992)
  expect(monitor.getRpcMetrics().pending).toBe(0)
})

test("worker construction failure does not poison the shared startup promise", async () => {
  const replacement = new FakeTranscriptWorker()
  let attempts = 0
  const { monitor, clock } = harness({
    workerFactory: () => {
      if (attempts++ === 0) throw new Error("worker unavailable")
      return replacement as unknown as TranscriptWorker
    },
  })
  await flushRpc()
  const metrics = monitor.getDispatchConcurrencyMetrics()
  clock.advance(250)
  replacement.initialize()
  await flushRpc()
  const request = replacement.sent.find((msg) => msg.type === "getDispatchConcurrencyMetrics")!
  if (request.type !== "getDispatchConcurrencyMetrics") throw new Error("Missing RPC")
  replacement.reply({
    type: "dispatchConcurrencyMetricsResponse",
    requestId: request.requestId,
    metrics: { active: 0, queued: 0, maxConcurrent: 4 },
  })
  expect(await metrics).toMatchObject({ maxConcurrent: 4 })
  expect(monitor.getRpcMetrics().restarts).toBe(1)
})

test("shutdown during restart backoff cancels launch and every waiter", async () => {
  const { monitor, clock, workers } = harness()
  clock.advance(15_000)
  await flushRpc()
  const next = monitor.getDispatchConcurrencyMetrics().catch((error) => error)
  monitor.terminate()
  clock.advance(10_000)
  expect(await next).toMatchObject({ code: "CLOSED" })
  expect(workers).toHaveLength(1)
  expect(clock.callbacks.size).toBe(0)
})

test("worker deadlines are configurable and reject invalid limits", () => {
  expect(
    transcriptWorkerOptions({
      SWIZ_TRANSCRIPT_WORKER_RPC_TIMEOUT_MS: "200",
      SWIZ_TRANSCRIPT_WORKER_MAX_PENDING: "4",
    })
  ).toMatchObject({ rpcTimeoutMs: 200, maxPending: 4 })
  for (const value of ["0", "-1", "Infinity", "NaN", "2147483648"]) {
    expect(() => transcriptWorkerOptions({ SWIZ_TRANSCRIPT_WORKER_RPC_TIMEOUT_MS: value })).toThrow(
      "Invalid transcript RPC limit"
    )
  }
})

test("a single-slot registry still admits replacement startup after a worker loss", async () => {
  const { monitor, workers, clock } = harness({ maxPending: 1 })
  workers[0]!.emit("exit", 1)
  await flushRpc()
  await expect(monitor.getDispatchConcurrencyMetrics()).rejects.toMatchObject({ code: "CAPACITY" })
  clock.advance(250)
  workers[1]!.initialize()
  await flushRpc()
  const next = monitor.getDispatchConcurrencyMetrics()
  await flushRpc()
  const request = workers[1]!.sent.find((msg) => msg.type === "getDispatchConcurrencyMetrics")!
  if (request.type !== "getDispatchConcurrencyMetrics") throw new Error("Missing RPC")
  workers[1]!.reply({
    type: "dispatchConcurrencyMetricsResponse",
    requestId: request.requestId,
    metrics: { active: 0, queued: 0, maxConcurrent: 4 },
  })
  expect(await next).toMatchObject({ maxConcurrent: 4 })
  expect(monitor.getRpcMetrics()).toMatchObject({ pending: 0, restarts: 1, unavailable: false })
})

test("restart budget stops repeated worker failures with explicit unavailable metrics", async () => {
  const { monitor, workers, clock } = harness({ maxRestarts: 1 })
  workers[0]!.emit("exit", 1)
  await flushRpc()
  const replacement = monitor.getDispatchConcurrencyMetrics().catch((error) => error)
  clock.advance(250)
  workers[1]!.initialize()
  await flushRpc()
  workers[1]!.emit("error", new Error("crash"))
  expect(await replacement).toMatchObject({ code: "WORKER_EXIT" })
  expect(monitor.getRpcMetrics()).toMatchObject({ pending: 0, restarts: 1, unavailable: true })
  await expect(monitor.getDispatchConcurrencyMetrics()).rejects.toMatchObject({
    code: "UNAVAILABLE",
  })
  await expect(monitor.checkProject("/project")).rejects.toMatchObject({ code: "UNAVAILABLE" })
  clock.advance(60_000)
  expect(workers).toHaveLength(2)
  expect(workers.every((worker) => worker.terminated)).toBe(true)
  expect(clock.callbacks.size).toBe(0)
})
