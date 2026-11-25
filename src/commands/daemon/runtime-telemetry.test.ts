import { describe, expect, test } from "bun:test"
import {
  captureCpuProfile,
  EventLoopLagRecorder,
  getRuntimeTelemetry,
  handleCpuProfileRoute,
  handleStartupProfileRoute,
  startRuntimeTelemetry,
  startStartupProfile,
  summariseStackTraces,
} from "./runtime-telemetry.ts"

describe("startup profile", () => {
  test("is reported as running, then served from memory", async () => {
    startStartupProfile(1)
    const running = handleStartupProfileRoute()
    expect(running.status).toBe(202)
    expect(await running.text()).toContain("still running")

    const deadline = Date.now() + 10_000
    while (handleStartupProfileRoute().status === 202 && Date.now() < deadline) {
      await Bun.sleep(50)
    }
    const done = handleStartupProfileRoute()
    expect(done.status).toBe(200)
    expect(await done.text()).toContain("Profiled 1s")
  }, 15_000)
})

describe("summariseStackTraces", () => {
  const frame = (name: string, sourceURL?: string, line = 0xffffffff) => ({ name, sourceURL, line })
  const viaTaskStore = {
    frames: [
      frame("spawnSync"),
      frame("getParentProcessCommand", "/repo/src/agent-paths.ts", 82),
      frame("createDefaultTaskStore", "/repo/src/task-roots.ts", 104),
    ],
  }
  const other = { frames: [frame("parse"), frame("", "/repo/src/tasks/task-repository.ts", 763)] }

  test("ranks call chains by samples and names the callers of a built-in", () => {
    const summary = summariseStackTraces({
      interval: 0.001,
      traces: [viaTaskStore, other, viaTaskStore],
    })
    expect(summary).toHaveLength(2)
    expect(summary[0]).toStartWith("2 samples")
    expect(summary[0]).toContain(
      "spawnSync\n    <- getParentProcessCommand (src/agent-paths.ts:82)"
    )
    expect(summary[0]).toContain("createDefaultTaskStore (src/task-roots.ts:104)")
    expect(summary[1]).toContain("(anonymous) (tasks/task-repository.ts:763)")
  })

  test("returns nothing for shapes it does not recognise", () => {
    expect(summariseStackTraces(null)).toEqual([])
    expect(summariseStackTraces("a string")).toEqual([])
    expect(summariseStackTraces({ traces: "nope" })).toEqual([])
    expect(summariseStackTraces({ traces: [{ frames: null }] })).toEqual([])
  })
})

describe("EventLoopLagRecorder", () => {
  test("reports percentiles and counts only real stalls", () => {
    const recorder = new EventLoopLagRecorder(100, 100)
    for (let i = 0; i < 97; i++) recorder.record(1)
    recorder.record(250, Date.UTC(2026, 0, 1))
    recorder.record(1_500, Date.UTC(2026, 0, 1, 0, 0, 1))
    recorder.record(-5)

    const snapshot = recorder.snapshot()
    expect(snapshot.windowSamples).toBe(100)
    expect(snapshot.p50Ms).toBe(1)
    expect(snapshot.maxMs).toBe(1_500)
    expect(snapshot.stallsOver200Ms).toBe(2)
    expect(snapshot.stallsOver1s).toBe(1)
    expect(snapshot.lifetimeStalledMs).toBe(1_750)
    expect(snapshot.recentStalls).toEqual([
      { at: "2026-01-01T00:00:00.000Z", lagMs: 250 },
      { at: "2026-01-01T00:00:01.000Z", lagMs: 1_500 },
    ])
    // 1,847ms blocked out of a 100-sample window of 10,000ms + that lag.
    expect(snapshot.blockedPct).toBeCloseTo(15.6, 1)
  })

  test("an idle loop reports no blocking", () => {
    const recorder = new EventLoopLagRecorder(10, 100)
    for (let i = 0; i < 10; i++) recorder.record(0)
    expect(recorder.snapshot()).toMatchObject({
      blockedPct: 0,
      maxMs: 0,
      stallsOver200Ms: 0,
      lifetimeStallsOver200Ms: 0,
      recentStalls: [],
    })
  })

  test("the window forgets old samples but lifetime counters do not", () => {
    const recorder = new EventLoopLagRecorder(3, 100)
    recorder.record(900)
    for (let i = 0; i < 3; i++) recorder.record(0)
    const snapshot = recorder.snapshot()
    expect(snapshot.stallsOver200Ms).toBe(0)
    expect(snapshot.lifetimeStallsOver200Ms).toBe(1)
  })
})

describe("runtime telemetry sampling", () => {
  test("is null until started, measures a blocked loop, and stops cleanly", async () => {
    expect(getRuntimeTelemetry()).toBeNull()
    const stop = startRuntimeTelemetry()
    try {
      await Bun.sleep(250)
      const idle = getRuntimeTelemetry()
      expect(idle?.eventLoop.windowSamples).toBeGreaterThan(0)
      expect(idle?.eventLoop.stallsOver200Ms).toBe(0)

      // Block the thread synchronously, then yield so the delayed timer fires.
      const until = performance.now() + 450
      while (performance.now() < until) {
        // busy wait
      }
      await Bun.sleep(150)
      const blocked = getRuntimeTelemetry()
      expect(blocked?.eventLoop.maxMs).toBeGreaterThanOrEqual(300)
      expect(blocked?.eventLoop.lifetimeStallsOver200Ms).toBeGreaterThanOrEqual(1)
    } finally {
      stop()
    }
    expect(getRuntimeTelemetry()).toBeNull()
  })
})

describe("cpu profile", () => {
  test("returns a summary and refuses overlapping profiles", async () => {
    const first = captureCpuProfile(1)
    expect(await captureCpuProfile(1)).toBeNull()
    const result = await first
    expect(result?.seconds).toBe(1)
    expect(typeof result?.functions).toBe("string")

    const response = await handleCpuProfileRoute(new URL("http://x/debug/cpu-profile?seconds=1"))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("Profiled 1s")
  }, 15_000)
})
