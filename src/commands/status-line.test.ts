import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_SETTINGS } from "../settings.ts"
import {
  buildSettingsFlags,
  formatCountSegment,
  formatGitHubCiSegment,
  formatProjectState,
  getContextStatsPath,
  getGhCachePath,
  ghJsonCached,
  readContextStats,
  renderStatusLineFromSnapshot,
  summarizeGitHubCiRuns,
  updateContextStats,
} from "./status-line.ts"

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "swiz-ctx-stats-test-"))
}

describe("readContextStats", () => {
  it("returns null when no stats file exists", async () => {
    const dir = makeTempProject()
    expect(await readContextStats(dir)).toBeNull()
  })

  it("returns null for corrupt JSON", async () => {
    const dir = makeTempProject()
    const statsPath = getContextStatsPath(dir)
    mkdirSync(join(dir, ".swiz"), { recursive: true })
    writeFileSync(statsPath, "not-json")
    expect(await readContextStats(dir)).toBeNull()
  })

  it("returns null for invalid schema (missing fields)", async () => {
    const dir = makeTempProject()
    const statsPath = getContextStatsPath(dir)
    mkdirSync(join(dir, ".swiz"), { recursive: true })
    writeFileSync(statsPath, JSON.stringify({ minPct: 10 }))
    expect(await readContextStats(dir)).toBeNull()
  })

  it("returns null for zero values", async () => {
    const dir = makeTempProject()
    const statsPath = getContextStatsPath(dir)
    mkdirSync(join(dir, ".swiz"), { recursive: true })
    writeFileSync(statsPath, JSON.stringify({ minPct: 0, maxPct: 50 }))
    expect(await readContextStats(dir)).toBeNull()
  })

  it("reads valid stats", async () => {
    const dir = makeTempProject()
    const statsPath = getContextStatsPath(dir)
    mkdirSync(join(dir, ".swiz"), { recursive: true })
    writeFileSync(statsPath, JSON.stringify({ minPct: 15, maxPct: 85 }))
    const stats = await readContextStats(dir)
    expect(stats).toEqual({ minPct: 15, maxPct: 85 })
  })
})

describe("updateContextStats", () => {
  it("initializes both min and max on first non-zero observation", async () => {
    const dir = makeTempProject()
    const stats = await updateContextStats(dir, 42)
    expect(stats).toEqual({ minPct: 42, maxPct: 42 })
    expect(await readContextStats(dir)).toEqual({ minPct: 42, maxPct: 42 })
  })

  it("ignores 0% and returns existing stats", async () => {
    const dir = makeTempProject()
    await updateContextStats(dir, 50)
    const stats = await updateContextStats(dir, 0)
    expect(stats).toEqual({ minPct: 50, maxPct: 50 })
  })

  it("ignores 0% when no prior stats exist", async () => {
    const dir = makeTempProject()
    const stats = await updateContextStats(dir, 0)
    expect(stats).toBeNull()
  })

  it("updates min when smaller value observed", async () => {
    const dir = makeTempProject()
    await updateContextStats(dir, 50)
    const stats = await updateContextStats(dir, 20)
    expect(stats).toEqual({ minPct: 20, maxPct: 50 })
  })

  it("updates max when larger value observed", async () => {
    const dir = makeTempProject()
    await updateContextStats(dir, 50)
    const stats = await updateContextStats(dir, 90)
    expect(stats).toEqual({ minPct: 50, maxPct: 90 })
  })

  it("does not change extremes when value is within range", async () => {
    const dir = makeTempProject()
    await updateContextStats(dir, 20)
    await updateContextStats(dir, 80)
    const stats = await updateContextStats(dir, 50)
    expect(stats).toEqual({ minPct: 20, maxPct: 80 })
  })

  it("creates .swiz directory if missing", async () => {
    const dir = makeTempProject()
    await updateContextStats(dir, 33)
    const stats = await readContextStats(dir)
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

describe("buildSettingsFlags", () => {
  function stripAnsi(text: string): string {
    const esc = String.fromCharCode(27)
    return text.replace(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "")
  }

  it("returns no flags for default settings", () => {
    expect(buildSettingsFlags({ ...DEFAULT_SETTINGS, source: "global" })).toEqual([])
  })

  it("renders high-signal non-default toggles", () => {
    const flags = buildSettingsFlags({
      ...DEFAULT_SETTINGS,
      collaborationMode: "team",
      prMergeMode: false,
      pushGate: true,
      strictNoDirectMain: true,
      sandboxedEdits: false,
      source: "global",
    })
    const normalized = flags.map(stripAnsi).join(" ")

    expect(normalized).toContain("team")
    expect(normalized).toContain("pr-merge:off")
    expect(normalized).toContain("push-gate:on")
    expect(normalized).toContain("direct-main:off")
    expect(normalized).toContain("sandbox:off")
  })

  it("renders relaxed-collab collaboration mode", () => {
    const flags = buildSettingsFlags({
      ...DEFAULT_SETTINGS,
      collaborationMode: "relaxed-collab",
      source: "global",
    })
    const normalized = flags.map(stripAnsi).join(" ")
    expect(normalized).toContain("relaxed-collab")
  })

  it("shows catch-all count for uncovered non-default settings", () => {
    const flags = buildSettingsFlags({
      ...DEFAULT_SETTINGS,
      critiquesEnabled: false,
      source: "global",
    })
    const normalized = flags.map(stripAnsi).join(" ")
    expect(normalized).toContain("+1 cfg")
  })

  it("does not show catch-all when all uncovered settings are default", () => {
    const flags = buildSettingsFlags({
      ...DEFAULT_SETTINGS,
      collaborationMode: "team",
      source: "global",
    })
    const normalized = flags.map(stripAnsi).join(" ")
    expect(normalized).not.toContain("cfg")
  })

  it("catch-all count excludes already-covered settings", () => {
    const flags = buildSettingsFlags({
      ...DEFAULT_SETTINGS,
      collaborationMode: "team", // covered — should NOT be counted in catch-all
      critiquesEnabled: false, // uncovered — should appear in count
      source: "global",
    })
    const normalized = flags.map(stripAnsi).join(" ")
    expect(normalized).toContain("team")
    expect(normalized).toContain("+1 cfg")
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
    const raw = await Bun.file(getGhCachePath(dir)).text()
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

    const raw = await Bun.file(getGhCachePath(dir)).text()
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

describe("renderStatusLineFromSnapshot", () => {
  const baseSnapshot = {
    shortCwd: "swiz",
    gitInfo: "✦ main",
    gitBranch: "main",
    activeSegments: [],
    ciState: "none" as const,
    ciLabel: "",
    issueCount: 2,
    prCount: 1,
    reviewDecision: "",
    commentCount: 0,
    projectState: "developing" as const,
    settingsParts: [],
  }

  it("renders a stable three-line output shape from warm snapshots", () => {
    const out = renderStatusLineFromSnapshot(
      { model: { display_name: "claude-sonnet" } },
      baseSnapshot,
      50,
      1200,
      { minPct: 40, maxPct: 80 },
      0
    )
    const lines = out.split("\n")
    expect(lines.length).toBe(3)
  })

  it("respects segment gating semantics from snapshot activeSegments", () => {
    const out = renderStatusLineFromSnapshot(
      { model: { display_name: "claude-haiku" } },
      { ...baseSnapshot, activeSegments: ["model"] },
      0,
      0,
      null,
      0
    )
    expect(out).toContain("model")
    expect(out).not.toContain("backlog")
    expect(out).not.toContain("state")
  })

  it("renders the current CI status when present", () => {
    const out = renderStatusLineFromSnapshot(
      { model: { display_name: "claude-haiku" } },
      { ...baseSnapshot, ciState: "pending", ciLabel: "running" },
      0,
      0,
      null,
      0
    )
    expect(out).toContain("ci")
    expect(out).toContain("running")
  })
})

describe("summarizeGitHubCiRuns", () => {
  const baseRun = {
    status: "completed",
    conclusion: "success",
    workflowName: "CI",
    createdAt: "2026-03-12T12:00:00Z",
    event: "push",
  }

  it("returns null for empty data", () => {
    expect(summarizeGitHubCiRuns([])).toBeNull()
  })

  it("reports running when any latest workflow is active", () => {
    const summary = summarizeGitHubCiRuns([
      { ...baseRun, status: "in_progress", conclusion: "" },
      { ...baseRun, workflowName: "Lint", createdAt: "2026-03-12T12:01:00Z" },
    ])
    expect(summary).toEqual({ state: "pending", label: "running" })
  })

  it("reports failed when the latest workflow conclusion failed", () => {
    const summary = summarizeGitHubCiRuns([{ ...baseRun, conclusion: "failure" }])
    expect(summary).toEqual({ state: "failure", label: "failed" })
  })

  it("reports passing when all latest workflows succeeded", () => {
    const summary = summarizeGitHubCiRuns([
      baseRun,
      { ...baseRun, workflowName: "Lint", createdAt: "2026-03-12T12:01:00Z" },
    ])
    expect(summary).toEqual({ state: "success", label: "passing" })
  })

  it("ignores workflow_run and dynamic events", () => {
    const summary = summarizeGitHubCiRuns([
      { ...baseRun, event: "workflow_run", conclusion: "failure" },
      { ...baseRun, event: "dynamic", conclusion: "failure", createdAt: "2026-03-12T12:01:00Z" },
    ])
    expect(summary).toBeNull()
  })
})

describe("formatGitHubCiSegment", () => {
  it("returns an empty segment when no CI state is available", () => {
    expect(formatGitHubCiSegment("none", "")).toBe("")
  })

  it("renders a passing CI badge", () => {
    expect(formatGitHubCiSegment("success", "passing")).toContain("passing")
  })
})
