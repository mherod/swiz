import { describe, expect, test } from "bun:test"
import {
  createMetrics,
  HISTOGRAM_BUCKET_COUNT,
  recordDispatch,
  serializeMetrics,
} from "./metrics.ts"

describe("daemon histogram metrics", () => {
  test("serializes bounded percentiles, outcomes, routes, stages, and hook counts", () => {
    const metrics = createMetrics()
    const durations = [1, 2, 4, 8, 16, 32, 64, 128]
    for (const [index, durationMs] of durations.entries()) {
      recordDispatch(metrics, "preToolUse", durationMs, {
        route: "preToolUse",
        outcome: index === 6 ? "error" : index === 7 ? "timeout" : "success",
        stages: { capture: 1, repository: 2, syncHooks: durationMs },
        hookCount: index + 1,
      })
    }

    const event = serializeMetrics(metrics).byEvent.preToolUse
    expect(event).toMatchObject({
      count: 8,
      avgMs: 32,
      minMs: 1,
      p50Ms: 8,
      p95Ms: 128,
      p99Ms: 128,
      maxMs: 128,
      errorCount: 1,
      timeoutCount: 1,
      avgHookCount: 4.5,
      maxHookCount: 8,
    })
    expect(event?.routes.preToolUse).toMatchObject({ count: 8, p95Ms: 128 })
    expect(event?.routes.preToolUse?.stages).toMatchObject({
      capture: { count: 8, p50Ms: 1 },
      repository: { count: 8, p50Ms: 2 },
      syncHooks: { count: 8, p95Ms: 128 },
    })
  })

  test("retains fixed histogram storage instead of raw timing samples", () => {
    const metrics = createMetrics()
    for (let index = 0; index < 10_000; index++) {
      recordDispatch(metrics, `event-${index}`, index, {
        route: `route-${index}`,
        stages: { capture: index },
      })
    }

    expect(metrics.dispatches.size).toBeLessThanOrEqual(64)
    for (const event of metrics.dispatches.values()) {
      expect(event.buckets).toHaveLength(HISTOGRAM_BUCKET_COUNT)
      expect(event.routes.size).toBeLessThanOrEqual(16)
      for (const route of event.routes.values()) {
        expect(route.buckets).toHaveLength(HISTOGRAM_BUCKET_COUNT)
        expect(route.stages.size).toBeLessThanOrEqual(16)
      }
    }
  })

  test("keeps instrumentation p50 below the two millisecond budget", () => {
    const metrics = createMetrics()
    const samples: number[] = []
    for (let index = 0; index < 200; index++) {
      const startedAt = performance.now()
      recordDispatch(metrics, "preToolUse", index, {
        route: "preToolUse",
        stages: { capture: 1, repository: 1, enrichment: 1, syncHooks: 1, asyncHooks: 1 },
        hookCount: 5,
      })
      samples.push(performance.now() - startedAt)
    }
    samples.sort((a, b) => a - b)
    expect(samples[Math.ceil(samples.length * 0.5) - 1] ?? Number.POSITIVE_INFINITY).toBeLessThan(2)
  })
})
