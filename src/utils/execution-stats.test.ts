import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getExecutionStatsPath,
  readExecutionStats,
  readProjectExecutionStats,
} from "./execution-stats.ts"

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "swiz-exec-stats-test-"))
}

async function writeStats(dir: string, kind: "test" | "lint", content: unknown): Promise<void> {
  mkdirSync(join(dir, ".swiz"), { recursive: true })
  await Bun.write(getExecutionStatsPath(dir, kind), JSON.stringify(content))
}

describe("readExecutionStats", () => {
  it("returns null when no stats file exists", async () => {
    const dir = makeTempProject()
    expect(await readExecutionStats(dir, "test")).toBeNull()
  })

  it("returns null for corrupt JSON", async () => {
    const dir = makeTempProject()
    mkdirSync(join(dir, ".swiz"), { recursive: true })
    await Bun.write(getExecutionStatsPath(dir, "test"), "not-json")
    expect(await readExecutionStats(dir, "test")).toBeNull()
  })

  it("returns null for invalid schema or zero count", async () => {
    const dir = makeTempProject()
    await writeStats(dir, "test", { totalTimeMs: 100 })
    expect(await readExecutionStats(dir, "test")).toBeNull()
    await writeStats(dir, "test", { totalTimeMs: 100, count: 0 })
    expect(await readExecutionStats(dir, "test")).toBeNull()
  })

  it("computes average and negligible assessment under 5s", async () => {
    const dir = makeTempProject()
    await writeStats(dir, "test", { totalTimeMs: 2400, count: 2 })
    expect(await readExecutionStats(dir, "test")).toEqual({
      totalTimeMs: 2400,
      count: 2,
      averageMs: 1200,
      assessment: "negligible",
    })
  })

  it("flags significant assessment at or above 5s average", async () => {
    const dir = makeTempProject()
    await writeStats(dir, "lint", { totalTimeMs: 10000, count: 2 })
    const stats = await readExecutionStats(dir, "lint")
    expect(stats?.averageMs).toBe(5000)
    expect(stats?.assessment).toBe("significant")
  })
})

describe("readProjectExecutionStats", () => {
  it("returns null when neither stats file exists", async () => {
    const dir = makeTempProject()
    expect(await readProjectExecutionStats(dir)).toBeNull()
  })

  it("returns both kinds when present", async () => {
    const dir = makeTempProject()
    await writeStats(dir, "test", { totalTimeMs: 2400, count: 2 })
    await writeStats(dir, "lint", { totalTimeMs: 800, count: 1 })
    const stats = await readProjectExecutionStats(dir)
    expect(stats?.test?.averageMs).toBe(1200)
    expect(stats?.lint?.averageMs).toBe(800)
  })

  it("returns partial stats when only one kind recorded", async () => {
    const dir = makeTempProject()
    await writeStats(dir, "lint", { totalTimeMs: 800, count: 1 })
    const stats = await readProjectExecutionStats(dir)
    expect(stats?.test).toBeNull()
    expect(stats?.lint?.count).toBe(1)
  })
})
