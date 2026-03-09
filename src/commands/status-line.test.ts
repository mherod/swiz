import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  formatCountSegment,
  formatProjectState,
  getContextStatsPath,
  getGhCachePath,
  ghJsonCached,
  readContextStats,
  updateContextStats,
} from "./status-line.ts"

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

describe("formatCountSegment", () => {
  it("returns null for zero count", () => {
    expect(formatCountSegment(0, "issue", "issues", 10, 25)).toBeNull()
  })

  it("returns null for zero PR count", () => {
    expect(formatCountSegment(0, "PR", "PRs", 5, 12)).toBeNull()
  })

  it("renders singular label for count of 1", () => {
    const result = formatCountSegment(1, "issue", "issues", 10, 25)
    expect(result).not.toBeNull()
    expect(result).toContain("1 issue")
    expect(result).not.toContain("issues")
  })

  it("renders plural label for count > 1", () => {
    const result = formatCountSegment(3, "PR", "PRs", 5, 12)
    expect(result).not.toBeNull()
    expect(result).toContain("3 PRs")
  })
})

describe("formatProjectState", () => {
  it("returns null for null state", () => {
    expect(formatProjectState(null)).toBeNull()
  })

  it("returns null for undefined state", () => {
    expect(formatProjectState(undefined)).toBeNull()
  })

  it("renders 'developing' state", () => {
    const result = formatProjectState("developing")
    expect(result).not.toBeNull()
    expect(result).toContain("developing")
  })

  it("renders 'planning' state", () => {
    const result = formatProjectState("planning")
    expect(result).not.toBeNull()
    expect(result).toContain("planning")
  })
})

// ─── ghJsonCached — file-based TTL cache (regression for #188) ───────────────

describe("ghJsonCached", () => {
  function makeTempDir(): string {
    return mkdtempSync(join(tmpdir(), "swiz-gh-cache-test-"))
  }

  function seedCache(cwd: string, args: string[], value: unknown, expiresAt: number): void {
    const key = args.join("\x00")
    const store = { [key]: { value, expiresAt } }
    mkdirSync(join(cwd, ".swiz"), { recursive: true })
    writeFileSync(getGhCachePath(cwd), `${JSON.stringify(store)}\n`)
  }

  it("returns cached value before TTL expires", async () => {
    const dir = makeTempDir()
    const cachedIssues = [{ number: 42 }, { number: 43 }]
    const args = ["issue", "list", "--state", "open", "--json", "number", "--limit", "100"]
    seedCache(dir, args, cachedIssues, Date.now() + 30_000)

    // With a valid cache entry, ghJsonCached must return the cached value
    // without spawning gh (which would fail in test environments without a repo)
    const result = await ghJsonCached<unknown[]>(args, dir)
    expect(result).toEqual(cachedIssues)
  })

  it("returns null for expired cache entry (gh unavailable → null result written)", async () => {
    const dir = makeTempDir()
    const args = ["issue", "list", "--state", "open", "--json", "number", "--limit", "100"]
    // Seed with an already-expired entry
    seedCache(dir, args, [{ number: 1 }], Date.now() - 1)

    // gh will fail in temp dir (no git repo) → returns null, which is then cached
    const result = await ghJsonCached<unknown[]>(args, dir)
    expect(result).toBeNull()
  })

  it("writes the fetched value into the cache file on miss", async () => {
    const dir = makeTempDir()
    const args = ["pr", "list", "--state", "open", "--json", "number", "--limit", "100"]
    // No cache file — cold miss
    await ghJsonCached<unknown[]>(args, dir)

    // Cache file must now exist with the correct key
    const raw = readFileSync(getGhCachePath(dir), "utf8")
    const store = JSON.parse(raw) as Record<string, { value: unknown; expiresAt: number }>
    const key = args.join("\x00")
    expect(store[key]).toBeDefined()
    expect(store[key]!.expiresAt).toBeGreaterThan(Date.now())
  })

  it("evicts expired sibling entries on each write", async () => {
    const dir = makeTempDir()
    const staleArgs = ["issue", "list", "--state", "open", "--json", "number", "--limit", "100"]
    const freshArgs = ["pr", "list", "--state", "open", "--json", "number", "--limit", "100"]

    // Seed an expired entry for staleArgs and a fresh one for freshArgs
    const staleKey = staleArgs.join("\x00")
    const freshKey = freshArgs.join("\x00")
    const store = {
      [staleKey]: { value: [], expiresAt: Date.now() - 1 },
      [freshKey]: { value: [{ number: 7 }], expiresAt: Date.now() + 30_000 },
    }
    mkdirSync(join(dir, ".swiz"), { recursive: true })
    writeFileSync(getGhCachePath(dir), `${JSON.stringify(store)}\n`)

    // Trigger a miss on a new key — this will evict the stale entry
    const newArgs = ["pr", "view", "main", "--json", "reviewDecision,comments"]
    await ghJsonCached(newArgs, dir)

    const raw = readFileSync(getGhCachePath(dir), "utf8")
    const after = JSON.parse(raw) as Record<string, unknown>
    // Stale entry must be evicted
    expect(after[staleKey]).toBeUndefined()
    // Fresh entry must be preserved
    expect(after[freshKey]).toBeDefined()
  })

  it("cache is isolated per cwd — different dirs do not share entries", async () => {
    const dir1 = makeTempDir()
    const dir2 = makeTempDir()
    const args = ["issue", "list", "--state", "open", "--json", "number", "--limit", "100"]
    const cachedData = [{ number: 99 }]
    seedCache(dir1, args, cachedData, Date.now() + 30_000)

    // dir2 has no cache file — must not return dir1's data
    const result = await ghJsonCached<unknown[]>(args, dir2)
    // gh will fail (no git repo) → null
    expect(result).toBeNull()
  })

  it("getGhCachePath returns path under .swiz", () => {
    expect(getGhCachePath("/some/project")).toBe("/some/project/.swiz/gh-cache.json")
  })
})
