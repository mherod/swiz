import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_SETTINGS } from "../settings.ts"
import {
  buildSettingsFlags,
  formatCountSegment,
  formatGitHubCiSegment,
  formatProjectState,
  getContextStatsPath,
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
    await Bun.write(statsPath, "not-json")
    expect(await readContextStats(dir)).toBeNull()
  })

  it("returns null for invalid schema (missing fields)", async () => {
    const dir = makeTempProject()
    const statsPath = getContextStatsPath(dir)
    mkdirSync(join(dir, ".swiz"), { recursive: true })
    await Bun.write(statsPath, JSON.stringify({ minPct: 10 }))
    expect(await readContextStats(dir)).toBeNull()
  })

  it("returns null for zero values", async () => {
    const dir = makeTempProject()
    const statsPath = getContextStatsPath(dir)
    mkdirSync(join(dir, ".swiz"), { recursive: true })
    await Bun.write(statsPath, JSON.stringify({ minPct: 0, maxPct: 50 }))
    expect(await readContextStats(dir)).toBeNull()
  })

  it("reads valid stats", async () => {
    const dir = makeTempProject()
    const statsPath = getContextStatsPath(dir)
    mkdirSync(join(dir, ".swiz"), { recursive: true })
    await Bun.write(statsPath, JSON.stringify({ minPct: 15, maxPct: 85 }))
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

  it("does not rewrite the stats file when the value stays within the current range", async () => {
    const dir = makeTempProject()
    await updateContextStats(dir, 20)
    await updateContextStats(dir, 80)

    const statsPath = getContextStatsPath(dir)
    const before = statSync(statsPath).mtimeMs

    await Bun.sleep(5)
    const stats = await updateContextStats(dir, 50)
    const after = statSync(statsPath).mtimeMs

    expect(stats).toEqual({ minPct: 20, maxPct: 80 })
    expect(after).toBe(before)
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
    fetchStatus: "ok" as const,
    reviewDecision: "",
    commentCount: 0,
    projectState: "developing" as const,
    settingsParts: [],
  }

  it("renders a stable three-line output shape from warm snapshots", () => {
    const out = renderStatusLineFromSnapshot({
      input: { model: { display_name: "claude-sonnet" } },
      snapshot: baseSnapshot,
      ctxPct: 50,
      ctxTokens: 1200,
      ctxStats: { minPct: 40, maxPct: 80 },
      timeOffset: 0,
    })
    const lines = out.split("\n")
    expect(lines.length).toBe(3)
  })

  it("respects segment gating semantics from snapshot activeSegments", () => {
    const out = renderStatusLineFromSnapshot({
      input: { model: { display_name: "claude-haiku" } },
      snapshot: { ...baseSnapshot, activeSegments: ["model"] },
      ctxPct: 0,
      ctxTokens: 0,
      ctxStats: null,
      timeOffset: 0,
    })
    expect(out).toContain("model")
    expect(out).not.toContain("backlog")
    expect(out).not.toContain("state")
  })

  it("renders the current CI status when present", () => {
    const out = renderStatusLineFromSnapshot({
      input: { model: { display_name: "claude-haiku" } },
      snapshot: { ...baseSnapshot, ciState: "pending", ciLabel: "running" },
      ctxPct: 0,
      ctxTokens: 0,
      ctxStats: null,
      timeOffset: 0,
    })
    expect(out).toContain("ci")
    expect(out).toContain("running")
  })

  it("does not render CI when snapshot.ignoreCi is set", () => {
    const out = renderStatusLineFromSnapshot({
      input: { model: { display_name: "claude-haiku" } },
      snapshot: {
        ...baseSnapshot,
        ignoreCi: true,
        ciState: "pending",
        ciLabel: "running",
      },
      ctxPct: 0,
      ctxTokens: 0,
      ctxStats: null,
      timeOffset: 0,
    })
    expect(out).not.toContain("running")
    const line1 = out.split("\n")[0] ?? ""
    expect(line1).not.toMatch(/\bci\b/i)
  })

  it("renders daemon metrics when the segment is enabled and project metrics exist", () => {
    const out = renderStatusLineFromSnapshot({
      input: { model: { display_name: "claude-haiku" } },
      snapshot: { ...baseSnapshot, activeSegments: ["metrics"] },
      daemonMetrics: { uptimeHuman: "4m 12s", totalDispatches: 18 },
      ctxPct: 0,
      ctxTokens: 0,
      ctxStats: null,
      timeOffset: 0,
    })

    expect(out).toContain("metrics")
    expect(out).toContain("4m 12s")
    expect(out).toContain("18")
    expect(out).toContain("dispatches")
  })

  it("suppresses daemon metrics when no project dispatches have been recorded", () => {
    const out = renderStatusLineFromSnapshot({
      input: { model: { display_name: "claude-haiku" } },
      snapshot: { ...baseSnapshot, activeSegments: ["metrics"] },
      daemonMetrics: { uptimeHuman: "0s", totalDispatches: 0 },
      ctxPct: 0,
      ctxTokens: 0,
      ctxStats: null,
      timeOffset: 0,
    })

    expect(out).not.toContain("metrics")
    expect(out).not.toContain("dispatches")
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
