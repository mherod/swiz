// Status line for Claude Code — outputs a rich ANSI-colored status bar.
// Receives a JSON object via stdin with model, workspace, context window, and cost info.
// Uses time-based rainbow cycling so colors shift on each render.

import { mkdir } from "node:fs/promises"
import { basename, join } from "node:path"
import { detectCiProviders } from "../detect.ts"
import {
  ensureGitExclude,
  type GitBranchStatus,
  getGitBranchStatus,
  getRepoSlug,
} from "../git-helpers.ts"
import { getIssueStoreReader } from "../issue-store.ts"
import {
  DEFAULT_SETTINGS,
  type EffectiveSwizSettings,
  getEffectiveSwizSettings,
  type ProjectState,
  readProjectSettings,
  readProjectState,
  readSwizSettings,
} from "../settings.ts"
import { isIncompleteTaskStatus, readSessionTasks } from "../tasks/task-recovery.ts"
import type { Command } from "../types.ts"
import type { SerializedDaemonMetrics } from "./daemon/cache/metrics.ts"
import { getDaemonPort } from "./daemon/daemon-admin.ts"

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
  /** When true (global ignore-ci), the status line must not render CI — even if ciState was populated. */
  ignoreCi?: boolean
  ciState?: GitHubCiState
  ciLabel?: string
  issueCount: number | null
  prCount: number | null
  fetchStatus: FetchStatus
  reviewDecision: string
  commentCount: number
  projectState: ProjectState | null
  settingsParts: string[]
  taskCounts?: TaskCounts | null
}

export type GitHubCiState = "success" | "pending" | "failure" | "neutral" | "none"

interface StatusLineDaemonMetrics {
  uptimeHuman: string
  totalDispatches: number
}

interface StatusLineRenderSettings {
  activeSegments: string[]
  ignoreCi: boolean
  settingsParts: string[]
}

interface GitHubCiRun {
  databaseId?: number
  status: string
  conclusion: string
  workflowName: string
  createdAt: string
  event: string
}

const DAEMON_PORT = getDaemonPort()
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
  let activeCount = 0
  let failingCount = 0
  let allSucceeded = latestRuns.length > 0
  let latestRun: GitHubCiRun | null = null

  for (const run of latestRuns) {
    if (isActiveCiRun(run)) activeCount++
    if (isFailingCiRun(run)) failingCount++
    if (run.status !== "completed" || run.conclusion !== "success") allSucceeded = false
    if (!latestRun || run.createdAt > latestRun.createdAt) latestRun = run
  }

  if (activeCount > 0) {
    return { state: "pending", label: activeCount === 1 ? "running" : `${activeCount} running` }
  }
  if (failingCount > 0) {
    return { state: "failure", label: failingCount === 1 ? "failed" : `${failingCount} failed` }
  }
  if (allSucceeded) {
    return { state: "success", label: "passing" }
  }
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
  const latest = new Map<string, GitHubCiRun>()
  for (const run of runs) {
    if (run.event === "dynamic" || run.event === "workflow_run") continue
    const existing = latest.get(run.workflowName)
    if (!existing || run.createdAt > existing.createdAt) {
      latest.set(run.workflowName, run)
    }
  }
  if (latest.size === 0) return null
  return classifyLatestRuns([...latest.values()])
}

const CI_STATE_FORMAT: Record<string, { color: string; icon: string; fallback: string }> = {
  success: { color: "\x1b[92m", icon: "✓", fallback: "passing" },
  pending: { color: "\x1b[93m", icon: "⏳", fallback: "running" },
  failure: { color: "\x1b[91m", icon: "✗", fallback: "failed" },
  neutral: { color: DIM, icon: "○", fallback: "unknown" },
}

export function formatGitHubCiSegment(
  state: GitHubCiState | null | undefined,
  label: string | null | undefined
): string {
  if (!state || state === "none") return ""
  const fmt = CI_STATE_FORMAT[state]
  if (!fmt) return ""
  return `${fmt.color}${fmt.icon} ${label || fmt.fallback}${R}`
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
  "ignoreCi",
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
  ["ignoreCi", `\x1b[93m⏭ ignore-ci${R}`, `\x1b[90m⏭ ignore-ci:off${R}`],
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

async function fetchIssuesViaStore(repo: string, _cwd: string): Promise<FetchResult<unknown>> {
  const reader = getIssueStoreReader()
  const cached = await reader.listIssues(repo, STALE_TTL_MS)
  return { data: cached, status: "ok" }
}

async function fetchPrsViaStore(repo: string, _cwd: string): Promise<FetchResult<unknown>> {
  const reader = getIssueStoreReader()
  const cached = await reader.listPullRequests(repo, STALE_TTL_MS)
  return { data: cached, status: "ok" }
}

async function fetchPrDetailViaStore(
  repo: string,
  branch: string,
  _cwd: string
): Promise<PrBranchDetail | null> {
  const reader = getIssueStoreReader()
  return reader.getPrBranchDetail<PrBranchDetail>(repo, branch)
}

async function fetchCiRunsViaStore(
  repo: string,
  branch: string,
  _cwd: string
): Promise<GitHubCiRun[] | null> {
  const reader = getIssueStoreReader()
  return reader.getCiBranchRuns<GitHubCiRun>(repo, branch)
}

// ── Per-project context usage extremes ─────────────────────────────────────

export interface ContextStats {
  minPct: number
  maxPct: number
}

export function getContextStatsPath(cwd: string): string {
  return join(cwd, ".swiz", "context-stats.json")
}

function parseContextStats(raw: string): ContextStats | null {
  try {
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

async function readContextStatsFromPath(path: string): Promise<ContextStats | null> {
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  return parseContextStats(await file.text())
}

export async function readContextStats(cwd: string): Promise<ContextStats | null> {
  return readContextStatsFromPath(getContextStatsPath(cwd))
}

export async function updateContextStats(cwd: string, pct: number): Promise<ContextStats | null> {
  const statsPath = getContextStatsPath(cwd)
  const existing = await readContextStatsFromPath(statsPath)
  if (pct <= 0) return existing
  if (existing && pct >= existing.minPct && pct <= existing.maxPct) return existing

  const stats: ContextStats = existing
    ? { minPct: Math.min(existing.minPct, pct), maxPct: Math.max(existing.maxPct, pct) }
    : { minPct: pct, maxPct: pct }
  try {
    await mkdir(join(cwd, ".swiz"), { recursive: true })
    await Bun.write(statsPath, `${JSON.stringify(stats, null, 2)}\n`)
    await ensureGitExclude(cwd, ".swiz/")
  } catch {
    // Non-fatal — status line continues without persisted stats
  }
  return stats
}

function activeSegmentsFromEffective(effective: EffectiveSwizSettings | null): string[] {
  return effective?.statusLineSegments ?? []
}

async function resolveStatusLineRenderSettings(
  cwd: string,
  sessionId: string | null | undefined
): Promise<StatusLineRenderSettings | null> {
  const [swizSettings, projectSettings] = await Promise.all([
    readSwizSettings().catch(() => null),
    readProjectSettings(cwd).catch(() => null),
  ])

  if (!swizSettings) return null

  const effective = getEffectiveSwizSettings(swizSettings, sessionId ?? null, projectSettings)
  return {
    activeSegments: activeSegmentsFromEffective(effective),
    ignoreCi: Boolean(effective.ignoreCi),
    settingsParts: buildSettingsFlags(effective),
  }
}

function applyRenderSettingsToSnapshot(
  snapshot: WarmStatusLineSnapshot,
  renderSettings: StatusLineRenderSettings | null
): WarmStatusLineSnapshot {
  if (!renderSettings) return snapshot
  return {
    ...snapshot,
    activeSegments: renderSettings.activeSegments,
    ignoreCi: renderSettings.ignoreCi,
    settingsParts: renderSettings.settingsParts,
  }
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

/** Worst fetch status wins — error > stale > OK. */
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

function buildGhFetchResults(
  issueResult: Awaited<ReturnType<typeof fetchIssuesViaStore>> | null,
  prResult: Awaited<ReturnType<typeof fetchPrsViaStore>> | null,
  prDetail: Awaited<ReturnType<typeof fetchPrDetailViaStore>> | null,
  ciData: GitHubCiRun[] | null,
  projectState: ProjectState | null
): GhFetchResults {
  return {
    issueData: issueResult?.data ?? null,
    prListData: prResult?.data ?? null,
    fetchStatus: computeFetchStatus(issueResult, prResult),
    prViewData: prDetail
      ? { reviewDecision: prDetail.reviewDecision, comments: new Array(prDetail.commentCount) }
      : null,
    ciData,
    projectState,
  }
}

async function fetchGhData(
  cwd: string,
  branch: string,
  needs: GhFetchNeeds
): Promise<GhFetchResults> {
  const repo = await getRepoSlug(cwd)
  const canFetchRepo = Boolean(repo)
  const canFetchBranch = canFetchRepo && Boolean(branch)

  const [issueResult, prResult, prDetail, ciData, projectState] = await Promise.all([
    conditionalFetch(needs.backlog && canFetchRepo, () => fetchIssuesViaStore(repo!, cwd)),
    conditionalFetch(needs.backlog && canFetchRepo, () => fetchPrsViaStore(repo!, cwd)),
    conditionalFetch(needs.pr && canFetchBranch, () => fetchPrDetailViaStore(repo!, branch, cwd)),
    conditionalFetch(needs.ci && canFetchBranch, () => fetchCiRunsViaStore(repo!, branch, cwd)),
    readProjectState(cwd),
  ])

  return buildGhFetchResults(issueResult, prResult, prDetail, ciData, projectState)
}

function extractGhCounts(gh: GhFetchResults) {
  return {
    issueCount: Array.isArray(gh.issueData) ? gh.issueData.length : null,
    prCount: Array.isArray(gh.prListData) ? gh.prListData.length : null,
    reviewDecision: gh.prViewData?.reviewDecision ?? "",
    commentCount: Array.isArray(gh.prViewData?.comments) ? gh.prViewData.comments.length : 0,
  }
}

function assembleSnapshot(
  shortCwd: string,
  gitResult: { branch: string; info: string },
  activeSegments: string[],
  gh: GhFetchResults,
  effective: EffectiveSwizSettings | null,
  taskCounts: TaskCounts | null
): WarmStatusLineSnapshot {
  const suppressCi = Boolean(effective?.ignoreCi)
  const ciSummary = suppressCi ? null : summarizeGitHubCiRuns(gh.ciData)
  return {
    shortCwd,
    gitInfo: gitResult.info,
    gitBranch: gitResult.branch,
    activeSegments,
    ignoreCi: suppressCi,
    ciState: ciSummary?.state ?? "none",
    ciLabel: ciSummary?.label ?? "",
    ...extractGhCounts(gh),
    fetchStatus: gh.fetchStatus,
    projectState: gh.projectState ?? null,
    settingsParts: buildSettingsFlags(effective),
    taskCounts,
  }
}

export async function computeWarmStatusLineSnapshot(
  cwd: string,
  sessionId: string | null | undefined
): Promise<WarmStatusLineSnapshot> {
  const shortCwd = shortenPath(cwd)
  const [gitResult, swizSettings, projectSettings, ciProviders, sessionTasks] = await Promise.all([
    getGitBranchAndInfo(cwd),
    readSwizSettings().catch(() => null),
    readProjectSettings(cwd).catch(() => null),
    detectCiProviders(cwd).catch(() => new Set()),
    sessionId ? readSessionTasks(sessionId).catch(() => []) : Promise.resolve([]),
  ])

  const effective = swizSettings
    ? getEffectiveSwizSettings(swizSettings, sessionId ?? null, projectSettings)
    : null
  const activeSegments = activeSegmentsFromEffective(effective)
  const needs = computeSegmentNeeds(activeSegments)
  if (!ciProviders.has("github-actions")) needs.ci = false
  if (effective?.ignoreCi) needs.ci = false
  const gh = await fetchGhData(cwd, gitResult.branch, needs)
  const taskCounts = sessionTasks.length > 0 ? buildTaskCountsFromTasks(sessionTasks) : null
  return assembleSnapshot(shortCwd, gitResult, activeSegments, gh, effective, taskCounts)
}

async function readWarmSnapshotFromDaemon(
  cwd: string,
  sessionId: string | null | undefined
): Promise<WarmStatusLineSnapshot | null> {
  const payload = await readDaemonJson<{ snapshot?: WarmStatusLineSnapshot }>(
    "/status-line/snapshot",
    {
      method: "POST",
      body: { cwd, sessionId },
    }
  )
  return payload?.snapshot ?? null
}

async function readDaemonJson<T>(
  path: string,
  init?: {
    method?: "GET" | "POST"
    body?: unknown
  }
): Promise<T | null> {
  const timeout = Number(process.env.SWIZ_STATUS_DAEMON_TIMEOUT_MS ?? "400")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(`${DAEMON_ORIGIN}${path}`, {
      method: init?.method ?? "GET",
      headers: init?.body ? { "content-type": "application/json" } : undefined,
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    })
    if (!res.ok) return null
    return (await res.json().catch(() => null)) as T | null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function parseDaemonMetrics(
  payload: SerializedDaemonMetrics | null | undefined
): StatusLineDaemonMetrics | null {
  if (!payload) return null
  if (typeof payload.uptimeHuman !== "string") return null
  if (typeof payload.totalDispatches !== "number") return null
  return {
    uptimeHuman: payload.uptimeHuman,
    totalDispatches: payload.totalDispatches,
  }
}

async function readProjectMetricsFromDaemon(cwd: string): Promise<StatusLineDaemonMetrics | null> {
  const payload = await readDaemonJson<SerializedDaemonMetrics>(
    `/metrics?project=${encodeURIComponent(cwd)}`
  )
  return parseDaemonMetrics(payload)
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

const LIVENESS_EMOJI: Record<FetchStatus, string> = {
  ok: "💚",
  stale: "🟡",
  error: "🔴",
}

function buildBacklogSegment(snapshot: WarmStatusLineSnapshot): string {
  const liveness = LIVENESS_EMOJI[snapshot.fetchStatus] ?? ""
  if (snapshot.fetchStatus === "error") return `${liveness} ${DIM}no data${R}`
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
  return counts ? `${liveness} ${counts}${staleMark}` : liveness
}

function buildReviewSegment(snapshot: WarmStatusLineSnapshot): string {
  if (snapshot.reviewDecision === "CHANGES_REQUESTED") return `\x1b[91m⚠ changes requested${R}`
  if (snapshot.reviewDecision === "APPROVED") return `\x1b[92m✓ approved${R}`
  if (snapshot.commentCount > 0) return `${DIM}💬 ${snapshot.commentCount}${R}`
  return ""
}

export interface TaskCounts {
  total: number
  incomplete: number
  pending: number
  inProgress: number
}

export function buildTaskCountsFromTasks(tasks: ReadonlyArray<{ status: string }>): TaskCounts {
  let pending = 0
  let inProgress = 0
  let incomplete = 0
  for (const t of tasks) {
    if (t.status === "pending") {
      pending++
      incomplete++
    } else if (t.status === "in_progress") {
      inProgress++
      incomplete++
    } else if (isIncompleteTaskStatus(t.status)) {
      incomplete++
    }
  }
  return { total: tasks.length, incomplete, pending, inProgress }
}

export function formatTaskCountSegment(counts: TaskCounts | null | undefined): string {
  if (!counts || counts.total === 0) return ""
  const parts: string[] = []
  const done = counts.total - counts.incomplete
  if (done > 0) parts.push(`\x1b[92m${"✔".repeat(done)}${R}`)
  if (counts.inProgress > 0) parts.push(`\x1b[93m${"◼".repeat(counts.inProgress)}${R}`)
  if (counts.pending > 0) parts.push(`\x1b[96m${"◻".repeat(counts.pending)}${R}`)
  return parts.join(" ")
}

function buildDaemonMetricsSegment(metrics: StatusLineDaemonMetrics | null | undefined): string {
  if (!metrics || metrics.totalDispatches <= 0) return ""
  const dispatchLabel = metrics.totalDispatches === 1 ? "dispatch" : "dispatches"
  return `${DIM}${metrics.uptimeHuman}${R} ${fg256(51)}${metrics.totalDispatches}${R} ${DIM}${dispatchLabel}${R}`
}

type SegChecker = (name: string) => boolean

function buildLine1(seg: SegChecker, snapshot: WarmStatusLineSnapshot, a2: string): string {
  const lbl = (s: string) => `${DIM}${s}${R}`
  const ciSeg = snapshot.ignoreCi ? "" : formatGitHubCiSegment(snapshot.ciState, snapshot.ciLabel)
  const reviewStatus = buildReviewSegment(snapshot)
  return joinGroups([
    seg("repo") ? `${lbl("repo")} ${a2}${snapshot.shortCwd}${R}` : "",
    seg("git") && snapshot.gitInfo ? `${lbl("git")} ${snapshot.gitInfo}` : "",
    seg("git") && ciSeg ? `${lbl("ci")} ${ciSeg}` : "",
    seg("pr") && reviewStatus ? `${lbl("pr")} ${reviewStatus}` : "",
  ])
}

function buildModeSeg(
  a4: string,
  agentName: string | undefined,
  vimMode: string | undefined
): string {
  const agentTag = agentName ? `${a4}[${agentName}]${R}` : ""
  const vimTag = vimMode ? formatVimMode(vimMode) : ""
  return [agentTag, vimTag].filter(Boolean).join(" ")
}

function buildLine3(
  seg: SegChecker,
  snapshot: WarmStatusLineSnapshot,
  daemonMetrics: StatusLineDaemonMetrics | null | undefined,
  a4: string,
  agentName: string | undefined,
  vimMode: string | undefined,
  taskCounts: TaskCounts | null | undefined
): string {
  const lbl = (s: string) => `${DIM}${s}${R}`
  const stateSeg = formatProjectState(snapshot.projectState)
  const ghCountSeg = buildBacklogSegment(snapshot)
  const daemonMetricsSeg = buildDaemonMetricsSegment(daemonMetrics)
  const taskSeg = formatTaskCountSegment(taskCounts)
  const modeSeg = buildModeSeg(a4, agentName, vimMode)
  const flagsStr = snapshot.settingsParts.join(" ")
  return joinGroups([
    seg("state") && stateSeg ? `${lbl("state")} ${stateSeg}` : "",
    seg("tasks") && taskSeg ? `${lbl("tasks")} ${taskSeg}` : "",
    seg("backlog") && ghCountSeg ? `${lbl("backlog")} ${ghCountSeg}` : "",
    seg("metrics") && daemonMetricsSeg ? `${lbl("metrics")} ${daemonMetricsSeg}` : "",
    seg("mode") && modeSeg ? `${lbl("mode")} ${modeSeg}` : "",
    seg("flags") && flagsStr ? `${lbl("flags")} ${flagsStr}` : "",
    seg("time") ? `${lbl("time")} ${DIM}${formatTime()}${R}` : "",
  ])
}

function buildLine2(opts: {
  seg: SegChecker
  ctxPct: number
  ctxTokens: number
  ctxStats: ContextStats | null
  model: string
  rb: (s: string, idx?: number) => string
}): string {
  const { seg, ctxPct, ctxTokens, ctxStats, model, rb } = opts
  const lbl = (s: string) => `${DIM}${s}${R}`
  const ctxSeg = buildContextSegment(ctxPct, ctxTokens, ctxStats)
  return joinGroups([
    seg("model") ? `${lbl("model")} ${rb(model)}` : "",
    seg("ctx") && ctxPct > 0 ? `${lbl("ctx")} ${ctxSeg}` : "",
  ])
}

export function renderStatusLineFromSnapshot(opts: {
  input: StatusLineInput
  snapshot: WarmStatusLineSnapshot
  daemonMetrics?: StatusLineDaemonMetrics | null
  taskCounts?: TaskCounts | null
  ctxPct: number
  ctxTokens: number
  ctxStats: ContextStats | null
  timeOffset: number
}): string {
  const {
    input,
    snapshot,
    daemonMetrics = null,
    taskCounts: explicitTaskCounts,
    ctxPct,
    ctxTokens,
    ctxStats,
    timeOffset,
  } = opts
  const taskCounts = explicitTaskCounts ?? snapshot.taskCounts ?? null
  const activeSegmentSet =
    snapshot.activeSegments.length > 0 ? new Set(snapshot.activeSegments) : null
  const seg: SegChecker = (name) => activeSegmentSet?.has(name) ?? true

  const a2 = fg256(RAINBOW[(timeOffset + 6) % RL]!)
  const a4 = fg256(RAINBOW[(timeOffset + 18) % RL]!)
  const rb = (s: string, idx = 0) => rainbowStr(s, idx, timeOffset)
  const model = input.model?.display_name ?? "claude"

  const line1 = buildLine1(seg, snapshot, a2)
  const line2 = buildLine2({ seg, ctxPct, ctxTokens, ctxStats, model, rb })
  const line3 = buildLine3(
    seg,
    snapshot,
    daemonMetrics,
    a4,
    input.agent?.name,
    input.vim?.mode,
    taskCounts
  )

  const fill = `${DIM}─${R}`
  return [
    `${rb("┌──")} ${line1 || fill}`,
    `${rb("├──")} ${line2 || fill}`,
    `${rb("└──")} ${line3 || fill}`,
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

    const sessionId = input.session_id ?? null
    const [ctxStats, warmSnapshot, daemonMetrics, renderSettings, sessionTasks] = await Promise.all(
      [
        updateContextStats(cwd, ctxPct),
        readWarmSnapshotFromDaemon(cwd, sessionId),
        readProjectMetricsFromDaemon(cwd),
        resolveStatusLineRenderSettings(cwd, sessionId),
        sessionId ? readSessionTasks(sessionId).catch(() => []) : Promise.resolve([]),
      ]
    )
    const snapshot = applyRenderSettingsToSnapshot(
      warmSnapshot ?? (await computeWarmStatusLineSnapshot(cwd, sessionId)),
      renderSettings
    )
    // Fallback: if the daemon snapshot doesn't include taskCounts (old daemon),
    // compute from the locally-read session tasks.
    const taskCounts =
      snapshot.taskCounts ??
      (sessionTasks.length > 0 ? buildTaskCountsFromTasks(sessionTasks) : null)

    console.log(
      renderStatusLineFromSnapshot({
        input,
        snapshot,
        daemonMetrics,
        taskCounts,
        ctxPct,
        ctxTokens,
        ctxStats,
        timeOffset,
      })
    )
  },
}
