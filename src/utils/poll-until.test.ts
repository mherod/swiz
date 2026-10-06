import { describe, expect, it } from "bun:test"
import { pollUntil } from "./poll-until.ts"

function fakeClock() {
  let t = 0
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      t += ms
    },
    sleeps,
  }
}

describe("pollUntil", () => {
  it("returns done on the first accepted value without sleeping", async () => {
    const clock = fakeClock()
    const result = await pollUntil({
      fetch: async () => 1,
      isDone: (n) => n === 1,
      intervalMs: 100,
      timeoutMs: 1000,
      ...clock,
    })
    expect(result).toEqual({ done: true, value: 1 })
    expect(clock.sleeps).toEqual([])
  })

  it("fetches once more at the time budget boundary, then gives up", async () => {
    const clock = fakeClock()
    let fetches = 0
    const result = await pollUntil({
      fetch: async () => ++fetches,
      isDone: () => false,
      intervalMs: 400,
      timeoutMs: 1000,
      ...clock,
    })
    expect(result).toEqual({ done: false, value: 4 })
    expect(clock.sleeps).toEqual([400, 400, 200])
  })

  it("stops after maxAttempts and reports waits between attempts", async () => {
    const clock = fakeClock()
    const waits: number[] = []
    const result = await pollUntil({
      fetch: async () => null,
      isDone: (v) => v !== null,
      intervalMs: 50,
      maxAttempts: 3,
      onWaiting: (_v, { attempt }) => waits.push(attempt),
      ...clock,
    })
    expect(result).toEqual({ done: false, value: null })
    expect(waits).toEqual([1, 2])
    expect(clock.sleeps).toEqual([50, 50])
  })
})
