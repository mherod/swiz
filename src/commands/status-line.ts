// Status line for Claude Code — outputs a rich ANSI-colored status bar.
// Receives a JSON object via stdin with model, workspace, context window, and cost info.
// Uses time-based rainbow cycling so colors shift on each render.

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import {
  ensureGitExclude,
  type GitBranchStatus,
  getGitBranchStatus,
  ghJson,
} from "../git-helpers.ts"
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

export interface WarmStatusLineSnapshot {
  shortCwd: string
  gitInfo: string
  gitBranch: string
  activeSegments: string[]
  ciState?: GitHubCiState
  ciLabel?: string
  issueCount: number | null
  prCount: number | null
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

/** Format raw git branch status into ANSI-colored info string for the status line. */
function formatGitBranchInfo(status: GitBranchStatus): { branch: string; info: string } {
  const { branch, ahead, behind, staged, unstaged, untracked, conflicts, stash, changedFallback } =
    status
  const dirty = staged > 0 || unstaged > 0 || untracked > 0 || conflicts > 0 || changedFallback > 0
  const branchColor = conflicts > 0 ? "\x1b[91m" : dirty ? "\x1b[93m" : "\x1b[92m"
  const icon = conflicts > 0 ? "!" : dirty ? "±" : "✦"

  const details: string[] = []
  if (ahead > 0) details.push(`\x1b[94m↑${ahead}${R}`)
  if (behind > 0) details.push(`\x1b[95m↓${behind}${R}`)
  if (staged > 0) details.push(`\x1b[92m+${staged}${R}`)
  if (unstaged > 0) details.push(`\x1b[93m~${unstaged}${R}`)
  if (untracked > 0) details.push(`\x1b[96m?${untracked}${R}`)
  if (conflicts > 0) details.push(`\x1b[91m!${conflicts}${R}`)
  if (stash > 0) details.push(`\x1b[35m$${stash}${R}`)
  if (details.length === 0 && changedFallback > 0) details.push(`${DIM}${changedFallback}~${R}`)
  const detailsStr = details.length ? ` ${details.join(" ")}` : ""

  return { branch, info: `${branchColor}${icon} ${branch}${R}${detailsStr}` }
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

export function summarizeGitHubCiRuns(
  runs: GitHubCiRun[] | null | undefined
): { state: GitHubCiState; label: string } | null {
  if (!Array.isArray(runs) || runs.length === 0) return null

  const relevant = runs.filter((run) => run.event !== "dynamic" && run.event !== "workflow_run")
  if (relevant.length === 0) return null

  const latestRuns = latestCiRunsByWorkflow(relevant)
  const active = latestRuns.filter((run) => run.status === "in_progress" || run.status === "queued")
  if (active.length > 0) {
    return {
      state: "pending",
      label: active.length === 1 ? "running" : `${active.length} running`,
    }
  }

  const failing = latestRuns.filter(
    (run) =>
      run.status === "completed" &&
      (run.conclusion === "failure" ||
        run.conclusion === "timed_out" ||
        run.conclusion === "action_required")
  )
  if (failing.length > 0) {
    return {
      state: "failure",
      label: failing.length === 1 ? "failed" : `${failing.length} failed`,
    }
  }

  if (
    latestRuns.length > 0 &&
    latestRuns.every((run) => run.status === "completed" && run.conclusion === "success")
  ) {
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

export function buildSettingsFlags(effective: EffectiveSwizSettings | null): string[] {
  if (!effective) return []

  const settingsParts: string[] = []
  if (effective.autoContinue !== DEFAULT_SETTINGS.autoContinue) {
    settingsParts.push(effective.autoContinue ? `\x1b[92m⟳ auto:on${R}` : `\x1b[90m⟳ auto:off${R}`)
  }
  if (effective.ambitionMode !== DEFAULT_SETTINGS.ambitionMode) {
    if (effective.ambitionMode === "aggressive") settingsParts.push(`\x1b[93m⚡ aggressive${R}`)
    if (effective.ambitionMode === "creative") settingsParts.push(`\x1b[95m✦ creative${R}`)
    if (effective.ambitionMode === "reflective") settingsParts.push(`\x1b[96m🪞 reflective${R}`)
  }
  if (effective.speak !== DEFAULT_SETTINGS.speak) {
    settingsParts.push(effective.speak ? `\x1b[96m🔊 narrator${R}` : `\x1b[90m🔇 narrator${R}`)
  }
  if (effective.collaborationMode !== DEFAULT_SETTINGS.collaborationMode) {
    if (effective.collaborationMode === "team") settingsParts.push(`\x1b[95m🤝 team${R}`)
    if (effective.collaborationMode === "solo") settingsParts.push(`\x1b[94m👤 solo${R}`)
    if (effective.collaborationMode === "relaxed-collab")
      settingsParts.push(`\x1b[93m🔀 relaxed-collab${R}`)
  }
  if (effective.prMergeMode !== DEFAULT_SETTINGS.prMergeMode) {
    settingsParts.push(
      effective.prMergeMode ? `\x1b[92m🔀 pr-merge:on${R}` : `\x1b[90m🔀 pr-merge:off${R}`
    )
  }
  if (effective.pushGate !== DEFAULT_SETTINGS.pushGate) {
    settingsParts.push(
      effective.pushGate ? `\x1b[93m🚧 push-gate:on${R}` : `\x1b[90m🚧 push-gate:off${R}`
    )
  }
  if (effective.strictNoDirectMain !== DEFAULT_SETTINGS.strictNoDirectMain) {
    settingsParts.push(
      effective.strictNoDirectMain
        ? `\x1b[91m🛡 direct-main:off${R}`
        : `\x1b[90m🛡 direct-main:on${R}`
    )
  }
  if (effective.sandboxedEdits !== DEFAULT_SETTINGS.sandboxedEdits) {
    settingsParts.push(
      effective.sandboxedEdits ? `\x1b[92m🧪 sandbox:on${R}` : `\x1b[93m🧪 sandbox:off${R}`
    )
  }

  // Catch-all: count uncovered settings that differ from defaults.
  let extraNonDefault = 0
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof typeof DEFAULT_SETTINGS>) {
    if (COVERED_SETTING_KEYS.has(key) || UNCOUNTABLE_SETTING_KEYS.has(key)) continue
    if (effective[key as keyof EffectiveSwizSettings] !== DEFAULT_SETTINGS[key]) extraNonDefault++
  }
  if (extraNonDefault > 0) {
    settingsParts.push(`\x1b[90m+${extraNonDefault} cfg${R}`)
  }

  return settingsParts
}

function joinGroups(groups: Array<string | null | undefined>): string {
  return groups.filter(Boolean).join(` ${DIM}│${R} `)
}

// ── Short-TTL file-based cache for gh list/view queries ─────────────────────
//
// gh api calls use the built-in --cache flag (see withApiCache in git-helpers).
// gh issue list / gh pr list / gh pr view have no equivalent flag, so we
// maintain a per-project JSON file at .swiz/gh-cache.json with TTL entries.

const GH_CACHE_TTL_MS: number = (() => {
  const raw = process.env.GH_API_CACHE_DURATION ?? "20s"
  const match = /^(\d+)(s|m)?$/.exec(raw)
  if (!match) return 20_000
  const n = parseInt(match[1]!, 10)
  return match[2] === "m" ? n * 60_000 : n * 1_000
})()

interface GhCacheEntry<T> {
  value: T
  expiresAt: number
}

type GhCacheStore = Record<string, GhCacheEntry<unknown>>

export function getGhCachePath(cwd: string): string {
  return join(cwd, ".swiz", "gh-cache.json")
}

async function readGhCache(cwd: string): Promise<GhCacheStore> {
  try {
    const raw = await readFile(getGhCachePath(cwd), "utf8")
    return JSON.parse(raw) as GhCacheStore
  } catch {
    return {}
  }
}

async function writeGhCache(cwd: string, store: GhCacheStore): Promise<void> {
  try {
    await mkdir(join(cwd, ".swiz"), { recursive: true })
    await writeFile(getGhCachePath(cwd), `${JSON.stringify(store)}\n`)
  } catch {
    // Non-fatal: status line continues without persisted cache
  }
}

/**
 * Wrap ghJson with a file-based TTL cache stored in .swiz/gh-cache.json.
 * Cache key is the serialised arg list so each unique command variant is
 * cached independently. Expired entries are evicted on each write.
 */
export async function ghJsonCached<T>(args: string[], cwd: string): Promise<T | null> {
  const key = args.join("\x00")
  const now = Date.now()
  const store = await readGhCache(cwd)
  const entry = store[key] as GhCacheEntry<T> | undefined
  if (entry && entry.expiresAt > now) {
    return entry.value
  }
  const value = await ghJson<T>(args, cwd)
  store[key] = { value, expiresAt: now + GH_CACHE_TTL_MS }
  for (const k of Object.keys(store)) {
    const e = store[k] as GhCacheEntry<unknown>
    if (e.expiresAt <= now && k !== key) delete store[k]
  }
  await writeGhCache(cwd, store)
  return value
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
  const seg = (name: string) => activeSegments.length === 0 || activeSegments.includes(name)

  const needsPr = seg("pr")
  const needsBacklog = seg("backlog")
  const needsCi = seg("git")

  const prViewPromise =
    needsPr && gitResult.branch
      ? ghJsonCached<{ reviewDecision?: string; comments?: unknown[] }>(
          ["pr", "view", gitResult.branch, "--json", "reviewDecision,comments"],
          cwd
        )
      : Promise.resolve(null)
  const ciPromise =
    needsCi && gitResult.branch
      ? ghJsonCached<GitHubCiRun[]>(
          [
            "run",
            "list",
            "--branch",
            gitResult.branch,
            "--limit",
            "10",
            "--json",
            "status,conclusion,workflowName,createdAt,event",
          ],
          cwd
        )
      : Promise.resolve(null)

  const [issueData, prListData, prViewData, ciData, projectState] = await Promise.all([
    needsBacklog
      ? ghJsonCached<unknown[]>(
          ["issue", "list", "--state", "open", "--json", "number", "--limit", "100"],
          cwd
        )
      : Promise.resolve(null),
    needsBacklog
      ? ghJsonCached<unknown[]>(
          ["pr", "list", "--state", "open", "--json", "number", "--limit", "100"],
          cwd
        )
      : Promise.resolve(null),
    prViewPromise,
    ciPromise,
    readProjectState(cwd),
  ])
  const ciSummary = summarizeGitHubCiRuns(ciData)

  return {
    shortCwd,
    gitInfo: gitResult.info,
    gitBranch: gitResult.branch,
    activeSegments,
    ciState: ciSummary?.state ?? "none",
    ciLabel: ciSummary?.label ?? "",
    issueCount: Array.isArray(issueData) ? issueData.length : null,
    prCount: Array.isArray(prListData) ? prListData.length : null,
    reviewDecision: prViewData?.reviewDecision ?? "",
    commentCount: Array.isArray(prViewData?.comments) ? prViewData.comments.length : 0,
    projectState,
    settingsParts: buildSettingsFlags(effective),
  }
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

export function renderStatusLineFromSnapshot(
  input: StatusLineInput,
  snapshot: WarmStatusLineSnapshot,
  ctxPct: number,
  ctxTokens: number,
  ctxStats: ContextStats | null,
  timeOffset: number
): string {
  const model = input.model?.display_name ?? "claude"
  const agentName = input.agent?.name
  const vimMode = input.vim?.mode
  const seg = (name: string) =>
    snapshot.activeSegments.length === 0 || snapshot.activeSegments.includes(name)

  // Accent colors at fixed phase offsets
  const a2 = fg256(RAINBOW[(timeOffset + 6) % RL]!)
  const a4 = fg256(RAINBOW[(timeOffset + 18) % RL]!)

  const rb = (s: string, idx = 0) => rainbowStr(s, idx, timeOffset)
  const label = (s: string) => `${DIM}${s}${R}`

  const topLeft = rb("┌──")
  const midLeft = rb("├──")
  const bottomLeft = rb("└──")

  const ctxBar = progressBar(ctxPct, 20, ctxStats)
  const ctxColor = colorForPct(ctxPct)
  const tokenStr = ctxTokens > 0 ? ` ${DIM}${formatTokens(ctxTokens)}${R}` : ""
  const rangeSpread = ctxStats ? ctxStats.maxPct - ctxStats.minPct : 0
  const rangeWarn = rangeSpread > 0 && rangeSpread < 40 ? "⚠️ " : ""
  const rangeSeg =
    ctxStats && ctxStats.minPct !== ctxStats.maxPct
      ? ` ${DIM}${rangeWarn}(${ctxStats.minPct.toFixed(0)}–${ctxStats.maxPct.toFixed(0)}%)${R}`
      : ""
  const ctxSeg = `${ctxBar}${ctxColor}${ctxPct.toFixed(0)}%${R}${tokenStr}${rangeSeg}`

  const issueSeg =
    snapshot.issueCount !== null
      ? formatCountSegment(snapshot.issueCount, "issue", "issues", 10, 25)
      : ""
  const prSeg =
    snapshot.prCount !== null ? formatCountSegment(snapshot.prCount, "PR", "PRs", 5, 12) : ""
  const ghCountSeg =
    snapshot.issueCount !== null || snapshot.prCount !== null
      ? [issueSeg, prSeg].filter(Boolean).join("  ")
      : ""

  const stateSeg = formatProjectState(snapshot.projectState)
  const ciSeg = formatGitHubCiSegment(snapshot.ciState, snapshot.ciLabel)
  const reviewStatus =
    snapshot.reviewDecision === "CHANGES_REQUESTED"
      ? `\x1b[91m⚠ changes requested${R}`
      : snapshot.reviewDecision === "APPROVED"
        ? `\x1b[92m✓ approved${R}`
        : snapshot.commentCount > 0
          ? `${DIM}💬 ${snapshot.commentCount}${R}`
          : ""

  const agentTag = agentName ? `${a4}[${agentName}]${R}` : ""
  const vimTag = vimMode ? formatVimMode(vimMode) : ""
  const timeSeg = `${DIM}${formatTime()}${R}`
  const settingsSeg = snapshot.settingsParts.join(" ")

  const line1Groups = joinGroups([
    seg("repo") ? `${label("repo")} ${a2}${snapshot.shortCwd}${R}` : "",
    seg("git") && snapshot.gitInfo ? `${label("git")} ${snapshot.gitInfo}` : "",
    seg("git") && ciSeg ? `${label("ci")} ${ciSeg}` : "",
    seg("pr") && reviewStatus ? `${label("pr")} ${reviewStatus}` : "",
  ])
  const line2Groups = joinGroups([
    seg("model") ? `${label("model")} ${rb(model)}` : "",
    seg("ctx") && ctxPct > 0 ? `${label("ctx")} ${ctxSeg}` : "",
  ])
  const modeSeg = [agentTag, vimTag].filter(Boolean).join(" ")
  const line3Groups = joinGroups([
    seg("state") && stateSeg ? `${label("state")} ${stateSeg}` : "",
    seg("backlog") && ghCountSeg ? `${label("backlog")} ${ghCountSeg}` : "",
    seg("mode") && modeSeg ? `${label("mode")} ${modeSeg}` : "",
    seg("flags") && settingsSeg ? `${label("flags")} ${settingsSeg}` : "",
    seg("time") ? `${label("time")} ${timeSeg}` : "",
  ])

  const line1 = `${topLeft} ${line1Groups || `${DIM}─${R}`}`
  const line2 = `${midLeft} ${line2Groups || `${DIM}─${R}`}`
  const line3 = `${bottomLeft} ${line3Groups || `${DIM}─${R}`}`

  return `${line1}\n${line2}\n${line3}`
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
      renderStatusLineFromSnapshot(input, snapshot, ctxPct, ctxTokens, ctxStats, timeOffset)
    )
  },
}
