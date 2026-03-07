import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getContextStatsPath, readContextStats, updateContextStats } from "./status-line.ts"

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "swiz-ctx-stats-test-"))
}

describe("readContextStats", () => {
  it("returns null when no stats file exists", () => {
    const dir = makeTempProject()
    expect(readContextStats(dir)).toBeNull()
  })

  it("returns null for corrupt JSON", () => {
    const dir = makeTempProject()
    const statsPath = getContextStatsPath(dir)
    mkdirSync(join(dir, ".swiz"), { recursive: true })
    writeFileSync(statsPath, "not-json")
    expect(readContextStats(dir)).toBeNull()
  })

  it("returns null for invalid schema (missing fields)", () => {
    const dir = makeTempProject()
    const statsPath = getContextStatsPath(dir)
    mkdirSync(join(dir, ".swiz"), { recursive: true })
    writeFileSync(statsPath, JSON.stringify({ minPct: 10 }))
    expect(readContextStats(dir)).toBeNull()
  })

  it("returns null for zero values", () => {
    const dir = makeTempProject()
    const statsPath = getContextStatsPath(dir)
    mkdirSync(join(dir, ".swiz"), { recursive: true })
    writeFileSync(statsPath, JSON.stringify({ minPct: 0, maxPct: 50 }))
    expect(readContextStats(dir)).toBeNull()
  })

  it("reads valid stats", () => {
    const dir = makeTempProject()
    const statsPath = getContextStatsPath(dir)
    mkdirSync(join(dir, ".swiz"), { recursive: true })
    writeFileSync(statsPath, JSON.stringify({ minPct: 15, maxPct: 85 }))
    const stats = readContextStats(dir)
    expect(stats).toEqual({ minPct: 15, maxPct: 85 })
  })
})

describe("updateContextStats", () => {
  it("initializes both min and max on first non-zero observation", () => {
    const dir = makeTempProject()
    const stats = updateContextStats(dir, 42)
    expect(stats).toEqual({ minPct: 42, maxPct: 42 })
    expect(readContextStats(dir)).toEqual({ minPct: 42, maxPct: 42 })
  })

  it("ignores 0% and returns existing stats", () => {
    const dir = makeTempProject()
    updateContextStats(dir, 50)
    const stats = updateContextStats(dir, 0)
    expect(stats).toEqual({ minPct: 50, maxPct: 50 })
  })

  it("ignores 0% when no prior stats exist", () => {
    const dir = makeTempProject()
    const stats = updateContextStats(dir, 0)
    expect(stats).toBeNull()
  })

  it("updates min when smaller value observed", () => {
    const dir = makeTempProject()
    updateContextStats(dir, 50)
    const stats = updateContextStats(dir, 20)
    expect(stats).toEqual({ minPct: 20, maxPct: 50 })
  })

  it("updates max when larger value observed", () => {
    const dir = makeTempProject()
    updateContextStats(dir, 50)
    const stats = updateContextStats(dir, 90)
    expect(stats).toEqual({ minPct: 50, maxPct: 90 })
  })

  it("does not change extremes when value is within range", () => {
    const dir = makeTempProject()
    updateContextStats(dir, 20)
    updateContextStats(dir, 80)
    const stats = updateContextStats(dir, 50)
    expect(stats).toEqual({ minPct: 20, maxPct: 80 })
  })

  it("creates .swiz directory if missing", () => {
    const dir = makeTempProject()
    updateContextStats(dir, 33)
    const stats = readContextStats(dir)
    expect(stats).toEqual({ minPct: 33, maxPct: 33 })
  })
})
