import { describe, expect, test } from "bun:test"
import { createMetrics, serializeMetrics } from "./cache/metrics.ts"
import {
  type MemoryPressureConfig,
  MemoryPressureMonitor,
  memoryPressureConfig,
  memoryPressureResponse,
  readOsRss,
  startMemoryMonitoring,
} from "./memory-pressure.ts"

const config: MemoryPressureConfig = {
  highBytes: 1000,
  lowBytes: 600,
  confirmations: 3,
  cooldownMs: 500,
  intervalMs: 60_000,
}
const memory = (rss: number): NodeJS.MemoryUsage => ({
  rss,
  heapUsed: 20,
  heapTotal: 40,
  external: 10,
  arrayBuffers: 5,
})

function fixture() {
  const actions: boolean[] = []
  const monitor = new MemoryPressureMonitor(config, (degraded) => actions.push(degraded))
  const sample = (rss: number, now: number, os: number | null = null) =>
    monitor.sample(memory(rss), os, now)
  return { monitor, actions, sample }
}

test("publishes the pressure alarm alongside existing daemon metrics", () => {
  const metrics = {
    ...createMetrics(),
    memoryPressure: fixture().monitor.snapshot,
  }
  expect(serializeMetrics(metrics)).toHaveProperty("memoryPressure", metrics.memoryPressure)
})

describe("sustained pressure policy", () => {
  test("normal operation and isolated spikes retain high-water without triggering relief", () => {
    const f = fixture()
    for (const [now, rss] of [100, 1100, 100, 1200, 100].entries()) f.sample(rss, now)
    expect(f.actions).toEqual([])
    expect(f.monitor.snapshot.rssHighWaterBytes).toBe(1200)
    expect(f.monitor.snapshot.state).toBe("normal")
  })

  test("OS RSS overrides an understated runtime sample and only triggers once", () => {
    const f = fixture()
    for (let now = 0; now < 20; now++) f.sample(100, now, 2000)
    expect(f.actions).toEqual([true])
    expect(f.monitor.snapshot).toMatchObject({
      rss: 100,
      osRssBytes: 2000,
      effectiveRssBytes: 2000,
      rssHighWaterBytes: 2000,
      state: "degraded",
      pressureEvents: 1,
    })
  })

  test("requires low-water confirmation and cooldown before resuming", () => {
    const f = fixture()
    for (let now = 0; now < 3; now++) f.sample(1100, now)
    for (let now = 3; now < 10; now++) f.sample(500, now)
    expect(f.actions).toEqual([true])
    f.sample(800, 600)
    f.sample(500, 601)
    f.sample(500, 602)
    expect(f.actions).toEqual([true])
    f.sample(500, 603)
    expect(f.actions).toEqual([true, false])
    for (let now = 604; now < 607; now++) f.sample(1100, now)
    expect(f.actions).toEqual([true, false, true])
  })

  test("missing OS samples cannot clear an OS-detected alarm", () => {
    const f = fixture()
    for (let now = 0; now < 3; now++) f.sample(100, now, 2000)
    for (let now = 600; now < 610; now++) f.sample(100, now, null)
    expect(f.actions).toEqual([true])
    for (let now = 610; now < 613; now++) f.sample(100, now, 500)
    expect(f.actions).toEqual([true, false])
  })

  test("invalid measurements break confirmation and failed relief stays degraded", () => {
    const f = fixture()
    f.sample(1100, 1)
    f.sample(Number.NaN, 2)
    f.sample(1100, 3)
    f.sample(1100, 4)
    expect(f.actions).toEqual([])
    expect(f.monitor.snapshot.samplingErrors).toBe(1)
    const broken = new MemoryPressureMonitor(config, () => {
      throw new Error("unavailable")
    })
    for (let now = 0; now < 3; now++) broken.sample(memory(1100), null, now)
    expect(broken.snapshot.state).toBe("degraded")
    expect(broken.snapshot.actionErrors).toBe(1)
    for (let now = 600; now < 603; now++) broken.sample(memory(100), null, now)
    expect(broken.snapshot.state).toBe("degraded")
  })
})

test("configuration rejects unsafe values and supports explicit thresholds", () => {
  expect(memoryPressureConfig({}).highBytes).toBe(4096 * 1024 ** 2)
  expect(
    memoryPressureConfig({
      SWIZ_DAEMON_MEMORY_LIMIT_MB: "2048",
      SWIZ_DAEMON_MEMORY_RESUME_MB: "1024",
    }).lowBytes
  ).toBe(1024 ** 3)
  for (const value of ["0", "-1", "NaN", "Infinity", "1.5", ""]) {
    expect(() => memoryPressureConfig({ SWIZ_DAEMON_MEMORY_CONFIRMATIONS: value })).toThrow()
  }
  expect(() => memoryPressureConfig({ SWIZ_DAEMON_MEMORY_RESUME_MB: "4096" })).toThrow()
})

test("OS sampler reads only the self PID RSS and fails safely", async () => {
  const run: Parameters<typeof readOsRss>[0] = async (cmd, opts) => {
    expect(cmd).toEqual(["ps", "-o", "rss=", "-p", "123"])
    expect(opts?.timeoutMs).toBe(1000)
    return { stdout: "  1024\n", stderr: "", exitCode: 0, timedOut: false }
  }
  expect(await readOsRss(run, 123)).toBe(1024 ** 2)
  for (const stdout of ["", "private path", "-1", "NaN", "1024\n2048", "0"]) {
    expect(
      await readOsRss(async () => ({ stdout, stderr: "", exitCode: 0, timedOut: false }))
    ).toBeNull()
  }
  expect(
    await readOsRss(async () => {
      throw new Error("denied")
    })
  ).toBeNull()
  expect(
    await readOsRss(async () => ({ stdout: "1000", stderr: "", exitCode: 1, timedOut: true }))
  ).toBeNull()
})

test("singleflight sampler stays responsive and stops without a late pressure action", async () => {
  let finish!: (value: number | null) => void
  let reads = 0
  const metrics = createMetrics()
  const actions: boolean[] = []
  const sampling = startMemoryMonitoring(metrics, (degraded) => actions.push(degraded), config, {
    osRss: () => {
      reads++
      return new Promise((resolve) => {
        finish = resolve
      })
    },
    memory: () => memory(2000),
    now: () => 100,
  })
  await sampling.tick()
  expect(reads).toBe(1)
  expect(memoryPressureResponse("/memory", metrics)?.status).toBe(200)
  sampling.stop()
  finish(2000)
  await Promise.resolve()
  expect(actions).toEqual([])
  expect(metrics.memoryPressure?.sampledAt).toBeNull()
})

test("degradation rejects history reads while preserving task and dispatch routes", () => {
  const f = fixture()
  for (let now = 0; now < 3; now++) f.sample(1100, now)
  const metrics = { ...createMetrics(), memoryPressure: f.monitor.snapshot }
  for (const path of [
    "/sessions/projects",
    "/sessions/messages",
    "/transcript/index",
    "/status-line/snapshot",
  ]) {
    expect(memoryPressureResponse(path, metrics)?.status).toBe(503)
  }
  for (const path of ["/health", "/mcp/tool", "/dispatch", "/sessions/tasks", "/projects/tasks"]) {
    expect(memoryPressureResponse(path, metrics)).toBeNull()
  }
  for (let now = 600; now < 603; now++) f.sample(500, now)
  expect(memoryPressureResponse("/sessions/messages", metrics)).toBeNull()
})
