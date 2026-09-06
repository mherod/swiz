import { expect, test } from "bun:test"
import { createMetrics } from "./cache/metrics.ts"
import { FakeTranscriptWorker, flushRpc, workerClock } from "./cache/test-utils/rpc.ts"
import {
  type TranscriptWorker,
  WorkerTranscriptMonitor,
} from "./cache/worker-transcript-monitor.ts"
import { startTranscriptMonitoring } from "./transcript-monitor-loop.ts"

test("periodic guard releases on RPC timeout, worker replacement and shutdown", async () => {
  const clock = workerClock()
  const workers: FakeTranscriptWorker[] = []
  const monitor = new WorkerTranscriptMonitor(
    {
      manifestCache: { get: async () => [] },
      projectSettingsCache: { get: async () => ({ settings: null }) },
      cooldownRegistry: { checkAndMark: () => false },
    },
    {
      schedule: clock.schedule,
      workerFactory: () => {
        const worker = new FakeTranscriptWorker()
        workers.push(worker)
        return worker as unknown as TranscriptWorker
      },
    }
  )
  const metrics = createMetrics()
  const errors: unknown[] = []
  const loop = startTranscriptMonitoring(new Set(), monitor, metrics, (error) => errors.push(error))
  try {
    workers[0]!.initialize()
    const first = loop.tick()
    await flushRpc()
    await loop.tick()
    expect(
      workers[0]!.sent.filter((msg) => msg.type === "getDispatchConcurrencyMetrics")
    ).toHaveLength(1)
    clock.advance(5_000)
    await first
    expect(errors).toHaveLength(1)
    expect(loop.isMonitoring()).toBe(false)
    const next = loop.tick()
    await flushRpc()
    clock.advance(250)
    workers[1]!.initialize()
    await flushRpc()
    const request = workers[1]!.sent.find((msg) => msg.type === "getDispatchConcurrencyMetrics")!
    if (request.type !== "getDispatchConcurrencyMetrics") throw new Error("Missing RPC")
    workers[1]!.reply({
      type: "dispatchConcurrencyMetricsResponse",
      requestId: request.requestId,
      metrics: { active: 1, queued: 2, maxConcurrent: 4 },
    })
    await next
    expect(metrics.transcriptDispatch?.active).toBe(1)
    const last = loop.tick()
    await flushRpc()
    loop.stop()
    await last
    expect(loop.isMonitoring()).toBe(false)
    await loop.tick()
    expect(errors).toHaveLength(1)
    expect(monitor.getRpcMetrics().pending).toBe(0)
  } finally {
    loop.stop()
  }
})
