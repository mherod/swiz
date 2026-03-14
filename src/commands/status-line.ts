// Status line for Claude Code — outputs a rich ANSI-colored status bar.
// Receives a JSON object via stdin with model, workspace, context window, and cost info.
// Uses time-based rainbow cycling so colors shift on each render.

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import {
  ensureGitExclude,
  type GitBranchStatus,
  getGitBranchStatus,
  getRepoSlug,
  ghJson,
} from "../git-helpers.ts"
import { getIssueStore } from "../issue-store.ts"
import {
  DEFAULT_SETTINGS,
  type EffectiveSwizSettings,
  getEffectiveSwizSettings,
  type ProjectState,
  readProjectSettings,
  readProjectState,
  readSwizSettings,
} from "../settings.ts"
import type { Command } from "../types.ts"

interface StatusLineInput {
  model?: { display_name?: string }
  workspace?: { current_dir?: string }
  context_window?: { used_percentage?: number; current_usage?: number }
  cost?: { total_cost_usd?: number; total_duration_ms?: number }
  session_id?: string
  agent?: { name?: string }
  vim?: { mode?: string }
}

import { BOLD, DIM, RESET as R } from "../ansi.ts"

export type FetchStatus = "ok" | "stale" | "error"

export interface WarmStatusLineSnapshot {
  shortCwd: string
  gitInfo: string
  gitBranch: string
  activeSegments: string[]
  ciState?: GitHubCiState
  ciLabel?: string
  issueCount: number | null
  prCount: number | null
  fetchStatus: FetchStatus
  reviewDecision: string
  commentCount: number
  projectState: ProjectState | null
  settingsParts: string[]
}

export type GitHubCiState = "success" | "pending" | "failure" | "neutral" | "none"

interface GitHubCiRun {
  status: string
  conclusion: string
  workflowName: string
  createdAt: string
  event: string
}

const DAEMON_PORT = Number(process.env.SWIZ_DAEMON_PORT ?? "7943")
const DAEMON_ORIGIN = process.env.SWIZ_DAEMON_ORIGIN ?? `http://127.0.0.1:${DAEMON_PORT}`

// 256-color foreground: \x1b[38;5;Nm
const fg256 = (n: number) => `\x1b[38;5;${n}m`

// Rainbow palette — bright values only (≥118), all readable on dark terminals
const RAINBOW = [
  196,
  202,
  208,
  214,
  220,
  226, // red → yellow
  190,
  154,
  118, // yellow → green
  46,
  47,
  48,
  49,
  50,
  51, // green → cyan
  123,
  122,
  121,
  120, // cyan (bright)
  159,
  195,
  189,
  183,
  177,
  171, // cyan → magenta (bright)
  165,
  201,
  200,
  199,
  198,
  197, // magenta → red
]
const RL = RAINBOW.length

// Narrow window: spread characters across at most 6 palette steps
const WINDOW = 6

function rainbowStr(str: string, startIdx = 0, timeOffset: number): string {
  let out = ""
  for (let i = 0; i < str.length; i++) {
    out += fg256(RAINBOW[(timeOffset + ((startIdx + i) % WINDOW)) % RL]!) + str[i] + R
  }
  return out
}

function colorForPct(pct: number): string {
  if (pct >= 90) return "\x1b[91m" // brightRed
  if (pct >= 75) return "\x1b[93m" // brightYellow
  if (pct >= 50) return "\x1b[33m" // yellow
  return "\x1b[92m" // brightGreen
}

function progressBar(pct: number, width = 20, stats?: ContextStats | null): string {
  const cur = Math.round((pct / 100) * width)
  const color = colorForPct(pct)
  if (stats && stats.minPct !== stats.maxPct) {
    const minPos = Math.round((stats.minPct / 100) * width)
    const maxPos = Math.round((stats.maxPct / 100) * width)
    let out = ""
    for (let i = 0; i < width; i++) {
      if (i < cur) {
        out += `${color}█${R}`
      } else if (i >= minPos && i <= maxPos) {
        out += `${DIM}▒${R}`
      } else {
        out += `${DIM}░${R}`
      }
    }
    return out
  }
  return `${color}${"█".repeat(cur)}${DIM}${"░".repeat(width - cur)}${R}`
}

function shortenPath(dir: string): string {
  return basename(dir)
}

type GitDetailDef = [field: keyof GitBranchStatus, color: string, symbol: string]

const GIT_DETAIL_DEFS: GitDetailDef[] = [
  ["ahead", "\x1b[94m", "↑"],
  ["behind", "\x1b[95m", "↓"],
  ["staged", "\x1b[92m", "+"],
  ["unstaged", "\x1b[93m", "~"],
  ["untracked", "\x1b[96m", "?"],
  ["conflicts", "\x1b[91m", "!"],
  ["stash", "\x1b[35m", "$"],
]

function buildGitDetails(status: GitBranchStatus): string[] {
  const details: string[] = []
  for (const [field, color, symbol] of GIT_DETAIL_DEFS) {
    const count = status[field]
    if (typeof count === "number" && count > 0) details.push(`${color}${symbol}${count}${R}`)
  }
  if (details.length === 0 && status.changedFallback > 0) {
    details.push(`${DIM}${status.changedFallback}~${R}`)
  }
  return details
}

function isDirtyBranch(status: GitBranchStatus): boolean {
  return (
    status.staged > 0 ||
    status.unstaged > 0 ||
    status.untracked > 0 ||
    status.conflicts > 0 ||
    status.changedFallback > 0
  )
}

/** Format raw git branch status into ANSI-colored info string for the status line. */
function formatGitBranchInfo(status: GitBranchStatus): { branch: string; info: string } {
  const dirty = isDirtyBranch(status)
  const branchColor = status.conflicts > 0 ? "\x1b[91m" : dirty ? "\x1b[93m" : "\x1b[92m"
  const icon = status.conflicts > 0 ? "!" : dirty ? "±" : "✦"
  const details = buildGitDetails(status)
  const detailsStr = details.length ? ` ${details.join(" ")}` : ""
  return { branch: status.branch, info: `${branchColor}${icon} ${status.branch}${R}${detailsStr}` }
}

async function getGitBranchAndInfo(cwd: string): Promise<{ branch: string; info: string }> {
  const status = await getGitBranchStatus(cwd)
  if (!status) return { branch: "", info: "" }
  return formatGitBranchInfo(status)
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`
  return `${tokens}`
}

function formatVimMode(mode: string): string {
  switch (mode.toUpperCase()) {
    case "NORMAL":
      return `${BOLD}\x1b[94m[N]${R}`
    case "INSERT":
      return `${BOLD}\x1b[92m[I]${R}`
    case "VISUAL":
      return `${BOLD}\x1b[93m[V]${R}`
    case "REPLACE":
      return `${BOLD}\x1b[91m[R]${R}`
    default: {
      const c = mode.charAt(0).toUpperCase()
      return `${DIM}[${c}]${R}`
    }
  }
}

function formatTime(): string {
  const now = new Date()
  const hours = String(now.getHours()).padStart(2, "0")
  const mins = String(now.getMinutes()).padStart(2, "0")
  const secs = String(now.getSeconds()).padStart(2, "0")
  return `${hours}:${mins}:${secs}`
}

function colorForCount(count: number, medium: number, high: number): string {
  if (count >= high) return "\x1b[91m"
  if (count >= medium) return "\x1b[93m"
  if (count > 0) return "\x1b[92m"
  return DIM
}

export function formatCountSegment(
  count: number,
  singular: string,
  plural: string,
  medium: number,
  high: number
): string | null {
  if (count === 0) return null
  const color = colorForCount(count, medium, high)
  const label = count === 1 ? singular : plural
  return `${color}${count} ${label}${R}`
}

export function formatProjectState(state: ProjectState | null | undefined): string | null {
  if (!state) return null
  switch (state) {
    case "planning":
      return `\x1b[96m${state}${R}`
    case "developing":
      return `\x1b[92m${state}${R}`
    case "reviewing":
      return `\x1b[93m${state}${R}`
    case "addressing-feedback":
      return `\x1b[95m${state}${R}`
  }
}

function latestCiRunsByWorkflow(runs: GitHubCiRun[]): GitHubCiRun[] {
  const latest = new Map<string, GitHubCiRun>()
  for (const run of runs) {
    const existing = latest.get(run.workflowName)
    if (!existing || run.createdAt > existing.createdAt) {
      latest.set(run.workflowName, run)
    }
  }
  return [...latest.values()]
}

function normalizeCiLabel(raw: string | null | undefined): string {
  return (raw ?? "").replaceAll("_", " ")
}

function isActiveCiRun(run: GitHubCiRun): boolean {
  return run.status === "in_progress" || run.status === "queued"
}

function isFailingCiRun(run: GitHubCiRun): boolean {
  return (
    run.status === "completed" &&
    (run.conclusion === "failure" ||
      run.conclusion === "timed_out" ||
      run.conclusion === "action_required")
  )
}

function classifyLatestRuns(
  latestRuns: GitHubCiRun[]
): { state: GitHubCiState; label: string } | null {
  const active = latestRuns.filter(isActiveCiRun)
  if (active.length > 0) {
    return { state: "pending", label: active.length === 1 ? "running" : `${active.length} running` }
  }
  const failing = latestRuns.filter(isFailingCiRun)
  if (failing.length > 0) {
    return { state: "failure", label: failing.length === 1 ? "failed" : `${failing.length} failed` }
  }
  if (latestRuns.every((run) => run.status === "completed" && run.conclusion === "success")) {
    return { state: "success", label: "passing" }
  }
  const latestRun = latestRuns.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  if (!latestRun) return null
  const label =
    latestRun.status === "completed"
      ? normalizeCiLabel(latestRun.conclusion || "completed")
      : normalizeCiLabel(latestRun.status || "unknown")
  return { state: "neutral", label }
}

export function summarizeGitHubCiRuns(
  runs: GitHubCiRun[] | null | undefined
): { state: GitHubCiState; label: string } | null {
  if (!Array.isArray(runs) || runs.length === 0) return null
  const relevant = runs.filter((run) => run.event !== "dynamic" && run.event !== "workflow_run")
  if (relevant.length === 0) return null
  return classifyLatestRuns(latestCiRunsByWorkflow(relevant))
}

export function formatGitHubCiSegment(
  state: GitHubCiState | null | undefined,
  label: string | null | undefined
): string {
  if (!state || state === "none") return ""

  switch (state) {
    case "success":
      return `\x1b[92m✓ ${label || "passing"}${R}`
    case "pending":
      return `\x1b[93m⏳ ${label || "running"}${R}`
    case "failure":
      return `\x1b[91m✗ ${label || "failed"}${R}`
    case "neutral":
      return `${DIM}○ ${label || "unknown"}${R}`
  }
}

// Keys with dedicated indicators — excluded from the catch-all count.
const COVERED_SETTING_KEYS = new Set([
  "autoContinue",
  "ambitionMode",
  "speak",
  "collaborationMode",
  "prMergeMode",
  "pushGate",
  "strictNoDirectMain",
  "sandboxedEdits",
])

// Keys that cannot be compared with simple equality (arrays, objects, metadata).
const UNCOUNTABLE_SETTING_KEYS = new Set(["statusLineSegments", "sessions", "source"])

type BooleanFlagDef = [key: keyof EffectiveSwizSettings, onLabel: string, offLabel: string]

const BOOLEAN_FLAGS: BooleanFlagDef[] = [
  ["autoContinue", `\x1b[92m⟳ auto:on${R}`, `\x1b[90m⟳ auto:off${R}`],
  ["speak", `\x1b[96m🔊 narrator${R}`, `\x1b[90m🔇 narrator${R}`],
  ["prMergeMode", `\x1b[92m🔀 pr-merge:on${R}`, `\x1b[90m🔀 pr-merge:off${R}`],
  ["pushGate", `\x1b[93m🚧 push-gate:on${R}`, `\x1b[90m🚧 push-gate:off${R}`],
  ["strictNoDirectMain", `\x1b[91m🛡 direct-main:off${R}`, `\x1b[90m🛡 direct-main:on${R}`],
  ["sandboxedEdits", `\x1b[92m🧪 sandbox:on${R}`, `\x1b[93m🧪 sandbox:off${R}`],
]

const AMBITION_LABELS: Record<string, string> = {
  aggressive: `\x1b[93m⚡ aggressive${R}`,
  creative: `\x1b[95m✦ creative${R}`,
  reflective: `\x1b[96m🪞 reflective${R}`,
}

const COLLAB_LABELS: Record<string, string> = {
  team: `\x1b[95m🤝 team${R}`,
  solo: `\x1b[94m👤 solo${R}`,
  "relaxed-collab": `\x1b[93m🔀 relaxed-collab${R}`,
}

function collectBooleanFlags(effective: EffectiveSwizSettings, parts: string[]): void {
  for (const [key, onLabel, offLabel] of BOOLEAN_FLAGS) {
    if (effective[key] !== DEFAULT_SETTINGS[key as keyof typeof DEFAULT_SETTINGS]) {
      parts.push(effective[key] ? onLabel : offLabel)
    }
  }
}

function countExtraNonDefaults(effective: EffectiveSwizSettings): number {
  let count = 0
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof typeof DEFAULT_SETTINGS>) {
    if (COVERED_SETTING_KEYS.has(key) || UNCOUNTABLE_SETTING_KEYS.has(key)) continue
    if (effective[key as keyof EffectiveSwizSettings] !== DEFAULT_SETTINGS[key]) count++
  }
  return count
}

export function buildSettingsFlags(effective: EffectiveSwizSettings | null): string[] {
  if (!effective) return []
  const parts: string[] = []

  const ambitionLabel = AMBITION_LABELS[effective.ambitionMode]
  if (ambitionLabel) parts.push(ambitionLabel)

  const collabLabel = COLLAB_LABELS[effective.collaborationMode]
  if (collabLabel) parts.push(collabLabel)

  collectBooleanFlags(effective, parts)

  const extra = countExtraNonDefaults(effective)
  if (extra > 0) parts.push(`\x1b[90m+${extra} cfg${R}`)

  return parts
}

function joinGroups(groups: Array<string | null | undefined>): string {
  return groups.filter(Boolean).join(` ${DIM}│${R} `)
}

// ── IssueStore-backed cache helpers ──────────────────────────────────────────
//
// Reads from the shared SQLite IssueStore (populated by the daemon's upstream
// sync). Falls back to direct `gh` calls when the store has no fresh data,
// then upserts results so subsequent reads are fast.

interface PrBranchDetail {
  reviewDecision: string
  commentCount: number
}

/** 1 hour — serve stale data rather than showing nothing when API is down. */
const STALE_TTL_MS = 60 * 60 * 1000

interface FetchResult<T> {
  data: T[]
  status: FetchStatus
}

async function fetchIssuesViaStore(repo: string, cwd: string): Promise<FetchResult<unknown>> {
  const store = getIssueStore()
  const cached = store.listIssues(repo)
  if (cached.length > 0) return { data: cached, status: "ok" }
  const fresh = await ghJson<{ number: number }[]>(
    ["issue", "list", "--state", "open", "--json", "number", "--limit", "100"],
    cwd
  )
  if (fresh && fresh.length > 0) {
    store.upsertIssues(repo, fresh)
    return { data: fresh, status: "ok" }
  }
  if (fresh) return { data: [], status: "ok" }
  // API failed — serve stale data rather than empty
  const stale = store.listIssues(repo, STALE_TTL_MS)
  return { data: stale, status: stale.length > 0 ? "stale" : "error" }
}

async function fetchPrsViaStore(repo: string, cwd: string): Promise<FetchResult<unknown>> {
  const store = getIssueStore()
  const cached = store.listPullRequests(repo)
  if (cached.length > 0) return { data: cached, status: "ok" }
  const fresh = await ghJson<{ number: number }[]>(
    ["pr", "list", "--state", "open", "--json", "number", "--limit", "100"],
    cwd
  )
  if (fresh && fresh.length > 0) {
    store.upsertPullRequests(repo, fresh)
    return { data: fresh, status: "ok" }
  }
  if (fresh) return { data: [], status: "ok" }
  const stale = store.listPullRequests(repo, STALE_TTL_MS)
  return { data: stale, status: stale.length > 0 ? "stale" : "error" }
}

async function fetchPrDetailViaStore(
  repo: string,
  branch: string,
  cwd: string
): Promise<PrBranchDetail | null> {
  const store = getIssueStore()
  const cached = store.getPrBranchDetail<PrBranchDetail>(repo, branch)
  if (cached) return cached
  const fresh = await ghJson<{ reviewDecision?: string; comments?: unknown[] }>(
    ["pr", "view", branch, "--json", "reviewDecision,comments"],
    cwd
  )
  if (!fresh) {
    return store.getPrBranchDetail<PrBranchDetail>(repo, branch, STALE_TTL_MS)
  }
  const detail: PrBranchDetail = {
    reviewDecision: fresh.reviewDecision ?? "",
    commentCount: Array.isArray(fresh.comments) ? fresh.comments.length : 0,
  }
  store.upsertPrBranchDetail(repo, branch, detail)
  return detail
}

async function fetchCiRunsViaStore(
  repo: string,
  branch: string,
  cwd: string
): Promise<GitHubCiRun[] | null> {
  const store = getIssueStore()
  const cached = store.getCiBranchRuns<GitHubCiRun>(repo, branch)
  if (cached) return cached
  const fresh = await ghJson<GitHubCiRun[]>(
    [
      "run",
      "list",
      "--branch",
      branch,
      "--limit",
      "10",
      "--json",
      "status,conclusion,workflowName,createdAt,event",
    ],
    cwd
  )
  if (fresh) {
    store.upsertCiBranchRuns(repo, branch, fresh)
    return fresh
  }
  return store.getCiBranchRuns<GitHubCiRun>(repo, branch, STALE_TTL_MS)
}

// ── Per-project context usage extremes ─────────────────────────────────────

export interface ContextStats {
  minPct: number
  maxPct: number
}

export function getContextStatsPath(cwd: string): string {
  return join(cwd, ".swiz", "context-stats.json")
}

export async function readContextStats(cwd: string): Promise<ContextStats | null> {
  try {
    const raw = await readFile(getContextStatsPath(cwd), "utf8")
    const obj = JSON.parse(raw) as { minPct?: number; maxPct?: number } | null
    if (
      typeof obj?.minPct === "number" &&
      typeof obj?.maxPct === "number" &&
      obj.minPct > 0 &&
      obj.maxPct > 0
    ) {
      return { minPct: obj.minPct, maxPct: obj.maxPct }
    }
    return null
  } catch {
    return null
  }
}

export async function updateContextStats(cwd: string, pct: number): Promise<ContextStats | null> {
  if (pct <= 0) return readContextStats(cwd)
  const existing = await readContextStats(cwd)
  const stats: ContextStats = existing
    ? { minPct: Math.min(existing.minPct, pct), maxPct: Math.max(existing.maxPct, pct) }
    : { minPct: pct, maxPct: pct }
  try {
    await mkdir(join(cwd, ".swiz"), { recursive: true })
    await writeFile(getContextStatsPath(cwd), `${JSON.stringify(stats, null, 2)}\n`)
    await ensureGitExclude(cwd, ".swiz/")
  } catch {
    // Non-fatal — status line continues without persisted stats
  }
  return stats
}

function activeSegmentsFromEffective(effective: EffectiveSwizSettings | null): string[] {
  return effective?.statusLineSegments ?? []
}

interface GhFetchNeeds {
  pr: boolean
  backlog: boolean
  ci: boolean
}

function computeSegmentNeeds(activeSegments: string[]): GhFetchNeeds {
  const seg = (name: string) => activeSegments.length === 0 || activeSegments.includes(name)
  return { pr: seg("pr"), backlog: seg("backlog"), ci: seg("git") }
}

interface GhFetchResults {
  issueData: unknown[] | null
  prListData: unknown[] | null
  fetchStatus: FetchStatus
  prViewData: { reviewDecision?: string; comments?: unknown[] } | null
  ciData: GitHubCiRun[] | null
  projectState: ProjectState | null | undefined
}

/** Worst fetch status wins — error > stale > ok. */
function computeFetchStatus(
  issueResult: { status: FetchStatus } | null,
  prResult: { status: FetchStatus } | null
): FetchStatus {
  const statuses = [issueResult?.status, prResult?.status].filter(Boolean) as FetchStatus[]
  if (statuses.includes("error")) return "error"
  if (statuses.includes("stale")) return "stale"
  return "ok"
}

function conditionalFetch<T>(needed: boolean, fn: () => Promise<T>): Promise<T | null> {
  return needed ? fn() : Promise.resolve(null)
}

async function fetchGhData(
  cwd: string,
  branch: string,
  needs: GhFetchNeeds
): Promise<GhFetchResults> {
  const repo = await getRepoSlug(cwd)
  const hasRepo = Boolean(repo)

  const [issueResult, prResult, prDetail, ciData, projectState] = await Promise.all([
    conditionalFetch(needs.backlog && hasRepo, () => fetchIssuesViaStore(repo!, cwd)),
    conditionalFetch(needs.backlog && hasRepo, () => fetchPrsViaStore(repo!, cwd)),
    conditionalFetch(needs.pr && hasRepo && Boolean(branch), () =>
      fetchPrDetailViaStore(repo!, branch, cwd)
    ),
    conditionalFetch(needs.ci && hasRepo && Boolean(branch), () =>
      fetchCiRunsViaStore(repo!, branch, cwd)
    ),
    readProjectState(cwd),
  ])

  const prViewData = prDetail
    ? { reviewDecision: prDetail.reviewDecision, comments: new Array(prDetail.commentCount) }
    : null

  return {
    issueData: issueResult?.data ?? null,
    prListData: prResult?.data ?? null,
    fetchStatus: computeFetchStatus(issueResult, prResult),
    prViewData,
    ciData,
    projectState,
  }
}

function assembleSnapshot(
  shortCwd: string,
  gitResult: { branch: string; info: string },
  activeSegments: string[],
  gh: GhFetchResults,
  effective: EffectiveSwizSettings | null
): WarmStatusLineSnapshot {
  const ciSummary = summarizeGitHubCiRuns(gh.ciData)
  return {
    shortCwd,
    gitInfo: gitResult.info,
    gitBranch: gitResult.branch,
    activeSegments,
    ciState: ciSummary?.state ?? "none",
    ciLabel: ciSummary?.label ?? "",
    issueCount: Array.isArray(gh.issueData) ? gh.issueData.length : null,
    prCount: Array.isArray(gh.prListData) ? gh.prListData.length : null,
    fetchStatus: gh.fetchStatus,
    reviewDecision: gh.prViewData?.reviewDecision ?? "",
    commentCount: Array.isArray(gh.prViewData?.comments) ? gh.prViewData.comments.length : 0,
    projectState: gh.projectState ?? null,
    settingsParts: buildSettingsFlags(effective),
  }
}

export async function computeWarmStatusLineSnapshot(
  cwd: string,
  sessionId: string | null | undefined
): Promise<WarmStatusLineSnapshot> {
  const shortCwd = shortenPath(cwd)
  const [gitResult, swizSettings, projectSettings] = await Promise.all([
    getGitBranchAndInfo(cwd),
    readSwizSettings().catch(() => null),
    readProjectSettings(cwd).catch(() => null),
  ])

  const effective = swizSettings
    ? getEffectiveSwizSettings(swizSettings, sessionId ?? null, projectSettings)
    : null
  const activeSegments = activeSegmentsFromEffective(effective)
  const needs = computeSegmentNeeds(activeSegments)
  const gh = await fetchGhData(cwd, gitResult.branch, needs)
  return assembleSnapshot(shortCwd, gitResult, activeSegments, gh, effective)
}

async function readWarmSnapshotFromDaemon(
  cwd: string,
  sessionId: string | null | undefined
): Promise<WarmStatusLineSnapshot | null> {
  const timeout = Number(process.env.SWIZ_STATUS_DAEMON_TIMEOUT_MS ?? "400")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(`${DAEMON_ORIGIN}/status-line/snapshot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, sessionId }),
      signal: controller.signal,
    })
    if (!res.ok) return null
    const payload = (await res.json().catch(() => null)) as {
      snapshot?: WarmStatusLineSnapshot
    } | null
    return payload?.snapshot ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function buildContextSegment(
  ctxPct: number,
  ctxTokens: number,
  ctxStats: ContextStats | null
): string {
  const ctxBar = progressBar(ctxPct, 20, ctxStats)
  const ctxColor = colorForPct(ctxPct)
  const tokenStr = ctxTokens > 0 ? ` ${DIM}${formatTokens(ctxTokens)}${R}` : ""
  const rangeSpread = ctxStats ? ctxStats.maxPct - ctxStats.minPct : 0
  const rangeWarn = rangeSpread > 0 && rangeSpread < 40 ? "⚠️ " : ""
  const rangeSeg =
    ctxStats && ctxStats.minPct !== ctxStats.maxPct
      ? ` ${DIM}${rangeWarn}(${ctxStats.minPct.toFixed(0)}–${ctxStats.maxPct.toFixed(0)}%)${R}`
      : ""
  return `${ctxBar}${ctxColor}${ctxPct.toFixed(0)}%${R}${tokenStr}${rangeSeg}`
}

function buildBacklogSegment(snapshot: WarmStatusLineSnapshot): string {
  if (snapshot.fetchStatus === "error") return `\x1b[91m⚠ fetch failed${R}`
  const staleMark = snapshot.fetchStatus === "stale" ? ` ${DIM}(stale)${R}` : ""
  const issueSeg =
    snapshot.issueCount !== null
      ? formatCountSegment(snapshot.issueCount, "issue", "issues", 10, 25)
      : ""
  const prSeg =
    snapshot.prCount !== null ? formatCountSegment(snapshot.prCount, "PR", "PRs", 5, 12) : ""
  const counts =
    snapshot.issueCount !== null || snapshot.prCount !== null
      ? [issueSeg, prSeg].filter(Boolean).join("  ")
      : ""
  return counts ? `${counts}${staleMark}` : ""
}

function buildReviewSegment(snapshot: WarmStatusLineSnapshot): string {
  if (snapshot.reviewDecision === "CHANGES_REQUESTED") return `\x1b[91m⚠ changes requested${R}`
  if (snapshot.reviewDecision === "APPROVED") return `\x1b[92m✓ approved${R}`
  if (snapshot.commentCount > 0) return `${DIM}💬 ${snapshot.commentCount}${R}`
  return ""
}

type SegChecker = (name: string) => boolean

function buildLine1(seg: SegChecker, snapshot: WarmStatusLineSnapshot, a2: string): string {
  const lbl = (s: string) => `${DIM}${s}${R}`
  const ciSeg = formatGitHubCiSegment(snapshot.ciState, snapshot.ciLabel)
  const reviewStatus = buildReviewSegment(snapshot)
  return joinGroups([
    seg("repo") ? `${lbl("repo")} ${a2}${snapshot.shortCwd}${R}` : "",
    seg("git") && snapshot.gitInfo ? `${lbl("git")} ${snapshot.gitInfo}` : "",
    seg("git") && ciSeg ? `${lbl("ci")} ${ciSeg}` : "",
    seg("pr") && reviewStatus ? `${lbl("pr")} ${reviewStatus}` : "",
  ])
}

function buildLine3(
  seg: SegChecker,
  snapshot: WarmStatusLineSnapshot,
  a4: string,
  agentName: string | undefined,
  vimMode: string | undefined
): string {
  const lbl = (s: string) => `${DIM}${s}${R}`
  const stateSeg = formatProjectState(snapshot.projectState)
  const ghCountSeg = buildBacklogSegment(snapshot)
  const agentTag = agentName ? `${a4}[${agentName}]${R}` : ""
  const vimTag = vimMode ? formatVimMode(vimMode) : ""
  const modeSeg = [agentTag, vimTag].filter(Boolean).join(" ")
  return joinGroups([
    seg("state") && stateSeg ? `${lbl("state")} ${stateSeg}` : "",
    seg("backlog") && ghCountSeg ? `${lbl("backlog")} ${ghCountSeg}` : "",
    seg("mode") && modeSeg ? `${lbl("mode")} ${modeSeg}` : "",
    seg("flags") && snapshot.settingsParts.join(" ")
      ? `${lbl("flags")} ${snapshot.settingsParts.join(" ")}`
      : "",
    seg("time") ? `${lbl("time")} ${DIM}${formatTime()}${R}` : "",
  ])
}

export function renderStatusLineFromSnapshot(opts: {
  input: StatusLineInput
  snapshot: WarmStatusLineSnapshot
  ctxPct: number
  ctxTokens: number
  ctxStats: ContextStats | null
  timeOffset: number
}): string {
  const { input, snapshot, ctxPct, ctxTokens, ctxStats, timeOffset } = opts
  const model = input.model?.display_name ?? "claude"
  const seg: SegChecker = (name) =>
    snapshot.activeSegments.length === 0 || snapshot.activeSegments.includes(name)

  const a2 = fg256(RAINBOW[(timeOffset + 6) % RL]!)
  const a4 = fg256(RAINBOW[(timeOffset + 18) % RL]!)
  const rb = (s: string, idx = 0) => rainbowStr(s, idx, timeOffset)
  const lbl = (s: string) => `${DIM}${s}${R}`

  const ctxSeg = buildContextSegment(ctxPct, ctxTokens, ctxStats)
  const line1Groups = buildLine1(seg, snapshot, a2)
  const line2Groups = joinGroups([
    seg("model") ? `${lbl("model")} ${rb(model)}` : "",
    seg("ctx") && ctxPct > 0 ? `${lbl("ctx")} ${ctxSeg}` : "",
  ])
  const line3Groups = buildLine3(seg, snapshot, a4, input.agent?.name, input.vim?.mode)

  const topLeft = rb("┌──")
  const midLeft = rb("├──")
  const bottomLeft = rb("└──")

  return [
    `${topLeft} ${line1Groups || `${DIM}─${R}`}`,
    `${midLeft} ${line2Groups || `${DIM}─${R}`}`,
    `${bottomLeft} ${line3Groups || `${DIM}─${R}`}`,
  ].join("\n")
}

export const statusLineCommand: Command = {
  name: "status-line",
  description: "Output a rich ANSI status bar for Claude Code's statusLine hook",
  usage: "swiz status-line  # reads JSON from stdin",
  async run() {
    const input: StatusLineInput = await Bun.stdin.json().catch(() => ({}))

    const cwd = input.workspace?.current_dir ?? process.cwd()
    const ctxPct = input.context_window?.used_percentage ?? 0
    const ctxTokens = input.context_window?.current_usage ?? 0

    // Time-based offset: cycles through full rainbow every ~1 minute (~1.7s per step)
    const timeOffset = Math.floor(Date.now() / 1667) % RL

    const ctxStats = await updateContextStats(cwd, ctxPct)
    const snapshot =
      (await readWarmSnapshotFromDaemon(cwd, input.session_id ?? null)) ??
      (await computeWarmStatusLineSnapshot(cwd, input.session_id ?? null))

    console.log(
      renderStatusLineFromSnapshot({ input, snapshot, ctxPct, ctxTokens, ctxStats, timeOffset })
    )
  },
}
