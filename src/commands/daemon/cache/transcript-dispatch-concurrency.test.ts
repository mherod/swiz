import { describe, expect, test } from "bun:test"
import { TranscriptDispatchConcurrencyGate } from "./transcript-dispatch-concurrency.ts"

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe("TranscriptDispatchConcurrencyGate", () => {
  test("max 0 does not cap concurrent in-flight work", async () => {
    const gate = new TranscriptDispatchConcurrencyGate()
    gate.setMaxConcurrent(0)
    let peak = 0
    let active = 0
    const n = 8
    for (let i = 0; i < n; i++) {
      gate.schedule(async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 40))
        active--
      })
    }
    await new Promise((r) => setTimeout(r, 0))
    expect(peak).toBe(n)
    await new Promise((r) => setTimeout(r, 80))
    expect(active).toBe(0)
  })

  test("burst scheduling never exceeds cap and completes all runners", async () => {
    const gate = new TranscriptDispatchConcurrencyGate()
    gate.setMaxConcurrent(2)

    let active = 0
    let peak = 0
    const started: number[] = []
    const completed: number[] = []

    const releaseAll = deferred<void>()
    const done = Array.from({ length: 10 }, () => deferred<void>())

    for (let i = 0; i < 10; i++) {
      const idx = i
      gate.schedule(async () => {
        started.push(idx)
        active++
        peak = Math.max(peak, active)
        await releaseAll.promise
        active--
        completed.push(idx)
        done[idx]!.resolve()
      })
    }

    await new Promise<void>((r) => queueMicrotask(r))
    expect(active).toBe(2)
    expect(peak).toBe(2)
    expect(started).toHaveLength(2)

    releaseAll.resolve()
    await Promise.all(done.map((d) => d.promise))
    expect(completed).toHaveLength(10)
    expect(peak).toBeLessThanOrEqual(2)
  })

  test("burst with max=1 preserves FIFO start order deterministically", async () => {
    const gate = new TranscriptDispatchConcurrencyGate()
    gate.setMaxConcurrent(1)

    const started: number[] = []
    const completed: number[] = []
    const startedSignals = Array.from({ length: 6 }, () => deferred<void>())
    const finishGates = Array.from({ length: 6 }, () => deferred<void>())
    const done = Array.from({ length: 6 }, () => deferred<void>())

    for (let i = 0; i < 6; i++) {
      const idx = i
      gate.schedule(async () => {
        started.push(idx)
        startedSignals[idx]!.resolve()
        await finishGates[idx]!.promise
        completed.push(idx)
        done[idx]!.resolve()
      })
    }

    await new Promise<void>((r) => queueMicrotask(r))

    for (let i = 0; i < 6; i++) {
      await startedSignals[i]!.promise
      expect(started).toEqual(Array.from({ length: i + 1 }, (_, n) => n))
      finishGates[i]!.resolve()
      await done[i]!.promise
    }

    expect(completed).toEqual([0, 1, 2, 3, 4, 5])
  })

  test("positive max bounds concurrent dispatches under burst", async () => {
    const gate = new TranscriptDispatchConcurrencyGate()
    gate.setMaxConcurrent(2)
    let peak = 0
    let active = 0
    for (let i = 0; i < 10; i++) {
      gate.schedule(async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 25))
        active--
      })
    }
    await new Promise((r) => setTimeout(r, 5))
    expect(peak).toBeLessThanOrEqual(2)
    expect(peak).toBe(2)
    await new Promise((r) => setTimeout(r, 200))
    expect(active).toBe(0)
  })

  test("switching to unlimited drains queued runners (no stuck work)", async () => {
    const gate = new TranscriptDispatchConcurrencyGate()
    gate.setMaxConcurrent(1)
    let completed = 0
    for (let i = 0; i < 4; i++) {
      gate.schedule(async () => {
        await new Promise((r) => setTimeout(r, 5))
        completed++
      })
    }
    await new Promise((r) => setTimeout(r, 0))
    gate.setMaxConcurrent(0)
    await new Promise((r) => setTimeout(r, 150))
    expect(completed).toBe(4)
  })

  test("getActive/getQueueDepth/getMaxConcurrent expose metrics", async () => {
    const gate = new TranscriptDispatchConcurrencyGate()
    gate.setMaxConcurrent(2)
    expect(gate.getMaxConcurrent()).toBe(2)
    expect(gate.getActive()).toBe(0)
    expect(gate.getQueueDepth()).toBe(0)

    let running = 0
    for (let i = 0; i < 5; i++) {
      gate.schedule(async () => {
        running++
        await new Promise((r) => setTimeout(r, 50))
        running--
      })
    }
    await new Promise((r) => setTimeout(r, 5))
    // 2 should be active, 3 should be queued
    expect(gate.getActive()).toBe(2)
    expect(gate.getQueueDepth()).toBe(3)
    expect(gate.getMaxConcurrent()).toBe(2)

    await new Promise((r) => setTimeout(r, 200))
    expect(gate.getActive()).toBe(0)
    expect(gate.getQueueDepth()).toBe(0)
    expect(running).toBe(0)
  })
})
