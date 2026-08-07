import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import {
  DEFAULT_HOOK_LOG_MAX_AGE_MS,
  DEFAULT_HOOK_LOG_MAX_BYTES,
  type HookLogEntry,
  HookLogStore,
  MIN_HOOK_LOG_RECORDS,
  resolveHookLogConfig,
} from "./hook-log.ts"
import { TMP_ROOT } from "./temp-paths.ts"
import { splitJsonlLines } from "./utils/jsonl.ts"

const testDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    testDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function createStore(options?: {
  maxAgeMs?: number
  maxBytes?: number
}): Promise<{ logPath: string; store: HookLogStore }> {
  const directory = await mkdtemp(join(TMP_ROOT, "swiz-hook-log-test-"))
  testDirectories.push(directory)
  const logPath = join(directory, "hook-logs.jsonl")
  return {
    logPath,
    store: new HookLogStore({
      logPath,
      maxAgeMs: options?.maxAgeMs ?? DEFAULT_HOOK_LOG_MAX_AGE_MS,
      maxBytes: options?.maxBytes ?? DEFAULT_HOOK_LOG_MAX_BYTES,
      minRecords: MIN_HOOK_LOG_RECORDS,
    }),
  }
}

function entry(index: number, timestampMs: number): HookLogEntry {
  return {
    ts: new Date(timestampMs).toISOString(),
    event: "stop",
    hookEventName: "Stop",
    hook: `hook-${index}`,
    status: "ok",
    durationMs: index % 10,
    exitCode: 0,
  }
}

describe("hook-log configuration", () => {
  it("uses bounded defaults and accepts byte/age overrides", () => {
    expect(resolveHookLogConfig("/logs/hooks.jsonl", {})).toEqual({
      logPath: "/logs/hooks.jsonl",
      maxAgeMs: DEFAULT_HOOK_LOG_MAX_AGE_MS,
      maxBytes: DEFAULT_HOOK_LOG_MAX_BYTES,
      minRecords: MIN_HOOK_LOG_RECORDS,
    })
    expect(
      resolveHookLogConfig("/logs/hooks.jsonl", {
        SWIZ_HOOK_LOG_MAX_AGE_DAYS: "7",
        SWIZ_HOOK_LOG_MAX_BYTES: "4194304",
      })
    ).toMatchObject({ maxAgeMs: 7 * 24 * 60 * 60 * 1000, maxBytes: 4 * 1024 * 1024 })
  })
})

describe("HookLogStore", () => {
  it("serializes 100,000 records, compacts by bytes, and preserves reader ordering", async () => {
    const maxBytes = 4 * 1024 * 1024
    const { logPath, store } = await createStore({ maxBytes })
    const now = Date.now()
    const scheduleSamples: number[] = []
    const writes: Promise<void>[] = []

    for (let batchIndex = 0; batchIndex < 100; batchIndex++) {
      const batch = Array.from({ length: 1000 }, (_, offset) => {
        const index = batchIndex * 1000 + offset
        return entry(index, now - (100_000 - index) * 1000)
      })
      const startedAt = performance.now()
      writes.push(store.append(batch))
      scheduleSamples.push(performance.now() - startedAt)
    }
    await Promise.all(writes)

    const metrics = await store.maintain(now)
    const text = await Bun.file(logPath).text()
    const lines = splitJsonlLines(text)
    const parsed = lines.map((line) => JSON.parse(line) as HookLogEntry)
    scheduleSamples.sort((left, right) => left - right)

    expect(scheduleSamples[Math.floor(scheduleSamples.length / 2)]).toBeLessThan(2)
    expect(["compacted", "unchanged"]).toContain(metrics.lastMaintenanceResult)
    expect(metrics.currentBytes).toBeLessThanOrEqual(maxBytes * 0.75)
    expect(lines.length).toBeGreaterThanOrEqual(MIN_HOOK_LOG_RECORDS)
    const indexes = parsed.map((record) => Number(record.hook.slice("hook-".length)))
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right))

    const recent = await store.read(500)
    expect(recent).toHaveLength(500)
    expect(recent[0]?.hook).toBe("hook-99500")
    expect(recent.at(-1)?.hook).toBe("hook-99999")
  }, 120_000)

  it("uses the shared file lock across concurrent store instances", async () => {
    const directory = await mkdtemp(join(TMP_ROOT, "swiz-hook-log-lock-test-"))
    testDirectories.push(directory)
    const logPath = join(directory, "hook-logs.jsonl")
    const config = {
      logPath,
      maxAgeMs: DEFAULT_HOOK_LOG_MAX_AGE_MS,
      maxBytes: DEFAULT_HOOK_LOG_MAX_BYTES,
      minRecords: MIN_HOOK_LOG_RECORDS,
    }
    const stores = Array.from({ length: 4 }, () => new HookLogStore(config))
    const now = Date.now()

    await Promise.all(
      stores.map((store, storeIndex) =>
        store.append(
          Array.from({ length: 2500 }, (_, offset) => {
            const index = storeIndex * 2500 + offset
            return entry(index, now + index)
          })
        )
      )
    )
    await stores[0]!.maintain(now + 10_000)

    const lines = splitJsonlLines(await Bun.file(logPath).text())
    const parsed = lines.map((line) => JSON.parse(line) as HookLogEntry)
    expect(parsed).toHaveLength(10_000)
    expect(new Set(parsed.map((record) => record.hook)).size).toBe(10_000)
  })

  it("keeps the newest 10,000 records even when older than the age limit", async () => {
    const oneDay = 24 * 60 * 60 * 1000
    const { store } = await createStore({ maxAgeMs: oneDay })
    const now = Date.now()
    const old = Array.from({ length: 12_000 }, (_, index) => entry(index, now - 2 * oneDay))
    const recent = Array.from({ length: 1_000 }, (_, offset) =>
      entry(12_000 + offset, now - oneDay / 2)
    )

    await Promise.all([store.append(old), store.append(recent)])
    const metrics = await store.maintain(now)
    const retained = await store.read(MIN_HOOK_LOG_RECORDS)

    expect(metrics.retainedRecords).toBe(MIN_HOOK_LOG_RECORDS)
    expect(retained).toHaveLength(MIN_HOOK_LOG_RECORDS)
    expect(retained[0]?.hook).toBe("hook-3000")
    expect(retained.at(-1)?.hook).toBe("hook-12999")
  })

  it("reports a missing log without creating one", async () => {
    const { logPath, store } = await createStore()

    expect(await store.maintain()).toMatchObject({
      currentBytes: 0,
      lastMaintenanceResult: "missing",
      retainedRecords: 0,
    })
    expect(await Bun.file(logPath).exists()).toBe(false)
  })
})
