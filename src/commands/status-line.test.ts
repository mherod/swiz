import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_SETTINGS } from "../settings.ts"
import {
  buildSettingsFlags,
  buildTaskCountsFromTasks,
  computeWarmStatusLineSnapshot,
  formatActiveSkillsSegment,
  formatCountSegment,
  formatGitHubCiSegment,
  formatProjectState,
  formatTaskCountSegment,
  getContextStatsPath,
  readContextStats,
  renderStatusLineFromSnapshot,
  renderWantedStars,
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

  it("threads wantedLevel through to the task segment as stars", () => {
    const out = renderStatusLineFromSnapshot({
      input: { model: { display_name: "claude-sonnet" } },
      snapshot: baseSnapshot,
      taskCounts: { total: 5, incomplete: 3, pending: 2, inProgress: 1 },
      wantedLevel: 2,
      ctxPct: 0,
      ctxTokens: 0,
      ctxStats: null,
      timeOffset: 0,
    })
    expect(out).toContain("★★")
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

  it("renders metrics when local settings include the segment", async () => {
    const snapshot = await computeWarmStatusLineSnapshot(process.cwd(), "debug-session")
    const out = renderStatusLineFromSnapshot({
      input: { model: { display_name: "claude-haiku" } },
      snapshot,
      daemonMetrics: { uptimeHuman: "1h 00m 00s", totalDispatches: 12 },
      ctxPct: 0,
      ctxTokens: 0,
      ctxStats: null,
      timeOffset: 0,
    })

    expect(out).toContain("metrics")
    expect(out).toContain("12")
    expect(out).toContain("dispatches")
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

describe("formatTaskCountSegment", () => {
  it("returns empty string when no tasks", () => {
    expect(formatTaskCountSegment(null)).toBe("")
    expect(formatTaskCountSegment({ total: 0, incomplete: 0, pending: 0, inProgress: 0 })).toBe("")
  })

  it("renders in_progress, pending, and completed symbols", () => {
    const seg = formatTaskCountSegment({ total: 5, incomplete: 3, pending: 2, inProgress: 1 })
    expect(seg).toContain("✔✔") // 2 completed
    expect(seg).toContain("◼") // 1 in_progress
    expect(seg).toContain("◻◻") // 2 pending
    expect(seg).toContain("👍") // governance healthy: ≥1 inProgress, ≥1 pending, ≥2 incomplete
  })

  it("shows warning when governance thresholds not met", () => {
    // only in_progress tasks, no pending buffer
    const seg = formatTaskCountSegment({ total: 1, incomplete: 1, pending: 0, inProgress: 1 })
    expect(seg).toContain("⚠️")
    expect(seg).not.toContain("👍")
    expect(seg).not.toContain("👎")
  })

  it("shows no indicator when all tasks are done", () => {
    const seg = formatTaskCountSegment({ total: 2, incomplete: 0, pending: 0, inProgress: 0 })
    expect(seg).not.toContain("👍")
    expect(seg).not.toContain("👎")
  })

  it("appends duration label after governance indicator when provided", () => {
    const counts = { total: 5, incomplete: 3, pending: 2, inProgress: 1 }
    const seg = formatTaskCountSegment(counts, "5m")
    expect(seg).toContain("👍")
    expect(seg).toContain("5m")
    const segDown = formatTaskCountSegment(
      { total: 1, incomplete: 1, pending: 0, inProgress: 1 },
      "12s"
    )
    expect(segDown).toContain("⚠️")
    expect(segDown).toContain("12s")
  })

  it("appends red wanted-level stars when wantedLevel > 0", () => {
    const counts = { total: 5, incomplete: 3, pending: 2, inProgress: 1 }
    const seg = formatTaskCountSegment(counts, null, null, 2)
    expect(seg).toContain("★★")
    // still shows the compliance indicator alongside the stars
    expect(seg).toContain("👍")
  })

  it("renders no stars when wantedLevel is 0 or omitted", () => {
    const counts = { total: 5, incomplete: 3, pending: 2, inProgress: 1 }
    expect(formatTaskCountSegment(counts, null, null, 0)).not.toContain("★")
    expect(formatTaskCountSegment(counts)).not.toContain("★")
  })

  it("renderWantedStars caps at 3 and clears at 0", () => {
    expect(renderWantedStars(0)).toBe("")
    expect(renderWantedStars(null)).toBe("")
    expect(renderWantedStars(1)).toContain("★")
    expect(renderWantedStars(5)).toContain("★★★")
    expect(renderWantedStars(5)).not.toContain("★★★★")
  })

  it("upgrades to clapping emoji when good compliance has been held for ≥2 minutes", () => {
    const counts = { total: 5, incomplete: 3, pending: 2, inProgress: 1 }
    const seg = formatTaskCountSegment(counts, "2m", 120)
    expect(seg).toContain("👏")
    expect(seg).not.toContain("👍")
    expect(seg).toContain("2m")
  })

  it("keeps thumbs-up when good compliance is under 2 minutes", () => {
    const counts = { total: 5, incomplete: 3, pending: 2, inProgress: 1 }
    const seg = formatTaskCountSegment(counts, "1m", 119)
    expect(seg).toContain("👍")
    expect(seg).not.toContain("👏")
  })

  it("shows indicator without duration when label is null", () => {
    const seg = formatTaskCountSegment({ total: 5, incomplete: 3, pending: 2, inProgress: 1 }, null)
    expect(seg).toContain("👍")
    expect(seg).not.toContain("null")
  })

  it("renders all ✔ ticks when done count is at the cap", () => {
    const seg = formatTaskCountSegment({ total: 10, incomplete: 0, pending: 0, inProgress: 0 })
    const tickCount = (seg.match(/✔/g) ?? []).length
    expect(tickCount).toBe(10)
    expect(seg).not.toContain("⋯")
    expect(seg).not.toContain("+")
  })

  it("truncates ✔ ticks to 10 with overflow indicator when done > 10", () => {
    const seg = formatTaskCountSegment({ total: 15, incomplete: 0, pending: 0, inProgress: 0 })
    const tickCount = (seg.match(/✔/g) ?? []).length
    expect(tickCount).toBe(10)
    expect(seg).toContain("⋯")
    expect(seg).toContain("+5")
  })

  it("preserves overflow indicator alongside other counters", () => {
    const seg = formatTaskCountSegment({ total: 14, incomplete: 3, pending: 2, inProgress: 1 })
    const tickCount = (seg.match(/✔/g) ?? []).length
    expect(tickCount).toBe(10)
    expect(seg).toContain("+1") // 11 done → 1 overflow
    expect(seg).toContain("◼")
    expect(seg).toContain("◻◻")
    expect(seg).toContain("👍")
  })

  it("caps ◼ in_progress ticks at 10 with overflow indicator", () => {
    const seg = formatTaskCountSegment({ total: 14, incomplete: 14, pending: 0, inProgress: 14 })
    const tickCount = (seg.match(/◼/g) ?? []).length
    expect(tickCount).toBe(10)
    expect(seg).toContain("⋯")
    expect(seg).toContain("+4")
  })

  it("caps ◻ pending ticks at 10 with overflow indicator", () => {
    const seg = formatTaskCountSegment({ total: 13, incomplete: 13, pending: 12, inProgress: 1 })
    const tickCount = (seg.match(/◻/g) ?? []).length
    expect(tickCount).toBe(10)
    expect(seg).toContain("⋯")
    expect(seg).toContain("+2")
  })

  it("builds counts from task array", () => {
    const tasks = [
      { status: "in_progress" },
      { status: "pending" },
      { status: "pending" },
      { status: "completed" },
    ]
    const counts = buildTaskCountsFromTasks(tasks)
    expect(counts).toEqual({ total: 4, incomplete: 3, pending: 2, inProgress: 1 })
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

describe("formatActiveSkillsSegment", () => {
  it("returns empty string when skills are null, undefined or empty", () => {
    expect(formatActiveSkillsSegment(null)).toBe("")
    expect(formatActiveSkillsSegment(undefined)).toBe("")
    expect(formatActiveSkillsSegment([])).toBe("")
  })

  it("renders skills with leading slash and ANSI color formatting", () => {
    const seg = formatActiveSkillsSegment(["commit", "fix-tests"])
    expect(seg).toContain("/commit")
    expect(seg).toContain("/fix-tests")
  })

  it("deduplicates redundant skills", () => {
    const seg = formatActiveSkillsSegment(["commit", "commit", "compact-memory", "compact-memory"])
    const occurrencesOfCommit = (seg.match(/\/commit/g) || []).length
    const occurrencesOfCompact = (seg.match(/\/compact-memory/g) || []).length
    expect(occurrencesOfCommit).toBe(1)
    expect(occurrencesOfCompact).toBe(1)
  })

  it("caps to 6 distinct skills and appends ⋯+N overflow indicator", () => {
    const skills = ["one", "two", "three", "four", "five", "six", "seven", "eight"]
    const seg = formatActiveSkillsSegment(skills)
    const slashCount = (seg.match(/\//g) ?? []).length
    expect(slashCount).toBe(6)
    expect(seg).toContain("/one")
    expect(seg).toContain("/six")
    expect(seg).not.toContain("/seven")
    expect(seg).not.toContain("/eight")
    expect(seg).toContain("⋯")
    expect(seg).toContain("+2")
  })
})

describe("active skills rendering", () => {
  const baseSnapshotForSkills = {
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

  it("renders active skills when specified in snap and segment is active", () => {
    const out = renderStatusLineFromSnapshot({
      input: { model: { display_name: "claude-haiku" } },
      snapshot: {
        ...baseSnapshotForSkills,
        activeSegments: ["skills"],
        activeSkills: ["commit", "fix-tests"],
      },
      ctxPct: 0,
      ctxTokens: 0,
      ctxStats: null,
      timeOffset: 0,
    })
    expect(out).toContain("/commit")
    expect(out).toContain("/fix-tests")
  })

  it("suppresses skills when segment is disabled", () => {
    const out = renderStatusLineFromSnapshot({
      input: { model: { display_name: "claude-haiku" } },
      snapshot: {
        ...baseSnapshotForSkills,
        activeSegments: ["tasks"],
        activeSkills: ["commit", "fix-tests"],
      },
      ctxPct: 0,
      ctxTokens: 0,
      ctxStats: null,
      timeOffset: 0,
    })
    expect(out).not.toContain("/commit")
    expect(out).not.toContain("/fix-tests")
  })
})

describe("issueSyncStale warning in backlog segment", () => {
  const baseSnap = {
    shortCwd: "swiz",
    gitInfo: "✦ main",
    gitBranch: "main",
    activeSegments: [] as string[],
    ciState: "none" as const,
    ciLabel: "",
    issueCount: 3,
    prCount: 1,
    fetchStatus: "ok" as const,
    reviewDecision: "",
    commentCount: 0,
    projectState: null,
    settingsParts: [],
  }

  it("shows sync warning in backlog when issueSyncStale is true", () => {
    const out = renderStatusLineFromSnapshot({
      input: { model: { display_name: "claude-haiku" } },
      snapshot: { ...baseSnap, issueSyncStale: true },
      ctxPct: 0,
      ctxTokens: 0,
      ctxStats: null,
      timeOffset: 0,
    })
    expect(out).toContain("⚠ sync")
  })

  it("omits sync warning when issueSyncStale is false", () => {
    const out = renderStatusLineFromSnapshot({
      input: { model: { display_name: "claude-haiku" } },
      snapshot: { ...baseSnap, issueSyncStale: false },
      ctxPct: 0,
      ctxTokens: 0,
      ctxStats: null,
      timeOffset: 0,
    })
    expect(out).not.toContain("⚠ sync")
  })

  it("omits sync warning when issueSyncStale is null (non-daemon path)", () => {
    const out = renderStatusLineFromSnapshot({
      input: { model: { display_name: "claude-haiku" } },
      snapshot: { ...baseSnap, issueSyncStale: null },
      ctxPct: 0,
      ctxTokens: 0,
      ctxStats: null,
      timeOffset: 0,
    })
    expect(out).not.toContain("⚠ sync")
  })

  it("shows sync warning even when issue/PR counts are zero", () => {
    const out = renderStatusLineFromSnapshot({
      input: { model: { display_name: "claude-haiku" } },
      snapshot: { ...baseSnap, issueCount: 0, prCount: 0, issueSyncStale: true },
      ctxPct: 0,
      ctxTokens: 0,
      ctxStats: null,
      timeOffset: 0,
    })
    expect(out).toContain("⚠ sync")
  })
})
