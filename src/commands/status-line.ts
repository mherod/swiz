// Status line for Claude Code — outputs a rich ANSI-colored status bar.
// Receives a JSON object via stdin with model, workspace, context window, and cost info.
// Uses time-based rainbow cycling so colors shift on each render.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { type GitBranchStatus, getGitBranchStatus, ghJson } from "../git-helpers.ts"
import {
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

function formatCountSegment(
  count: number,
  singular: string,
  plural: string,
  medium: number,
  high: number
): string {
  const color = colorForCount(count, medium, high)
  const label = count === 1 ? singular : plural
  return `${color}${count} ${label}${R}`
}

function formatProjectState(state: ProjectState | null | undefined): string {
  if (!state) return `${DIM}no state${R}`
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

function joinGroups(groups: Array<string | null | undefined>): string {
  return groups.filter(Boolean).join(` ${DIM}│${R} `)
}

// ── Per-project context usage extremes ─────────────────────────────────────

export interface ContextStats {
  minPct: number
  maxPct: number
}

export function getContextStatsPath(cwd: string): string {
  return join(cwd, ".swiz", "context-stats.json")
}

export function readContextStats(cwd: string): ContextStats | null {
  try {
    const raw = readFileSync(getContextStatsPath(cwd), "utf8")
    const obj = JSON.parse(raw)
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

export function updateContextStats(cwd: string, pct: number): ContextStats | null {
  if (pct <= 0) return readContextStats(cwd)
  const existing = readContextStats(cwd)
  const stats: ContextStats = existing
    ? { minPct: Math.min(existing.minPct, pct), maxPct: Math.max(existing.maxPct, pct) }
    : { minPct: pct, maxPct: pct }
  try {
    const dir = join(cwd, ".swiz")
    mkdirSync(dir, { recursive: true })
    writeFileSync(getContextStatsPath(cwd), `${JSON.stringify(stats, null, 2)}\n`)
  } catch {
    // Non-fatal — status line continues without persisted stats
  }
  return stats
}

export const statusLineCommand: Command = {
  name: "status-line",
  description: "Output a rich ANSI status bar for Claude Code's statusLine hook",
  usage: "swiz status-line  # reads JSON from stdin",
  async run() {
    const input: StatusLineInput = await Bun.stdin.json().catch(() => ({}))

    const cwd = input.workspace?.current_dir ?? process.cwd()
    const model = input.model?.display_name ?? "claude"
    const ctxPct = input.context_window?.used_percentage ?? 0
    const ctxTokens = input.context_window?.current_usage ?? 0
    const agentName = input.agent?.name
    const vimMode = input.vim?.mode

    // Time-based offset: cycles through full rainbow every ~1 minute (~1.7s per step)
    const timeOffset = Math.floor(Date.now() / 1667) % RL

    // Accent colors at fixed phase offsets
    const a2 = fg256(RAINBOW[(timeOffset + 6) % RL]!)
    const a4 = fg256(RAINBOW[(timeOffset + 18) % RL]!)

    const shortCwd = shortenPath(cwd)

    const gitPromise = getGitBranchAndInfo(cwd)
    const prViewPromise = gitPromise.then(({ branch }) =>
      branch
        ? ghJson<{ reviewDecision?: string; comments?: unknown[] }>(
            ["pr", "view", branch, "--json", "reviewDecision,comments"],
            cwd
          )
        : null
    )

    const [gitResult, issueData, prListData, prViewData, swizSettings, projectSettings] =
      await Promise.all([
        gitPromise,
        ghJson<unknown[]>(
          ["issue", "list", "--state", "open", "--json", "number", "--limit", "100"],
          cwd
        ),
        ghJson<unknown[]>(
          ["pr", "list", "--state", "open", "--json", "number", "--limit", "100"],
          cwd
        ),
        prViewPromise,
        readSwizSettings().catch(() => null),
        readProjectSettings(cwd).catch(() => null),
      ])

    const { info: gitInfo } = gitResult

    // ── Segment visibility ───────────────────────────────────────────────────
    const effective = swizSettings
      ? getEffectiveSwizSettings(swizSettings, input.session_id ?? null, projectSettings)
      : null
    const activeSegments = new Set<string>(effective?.statusLineSegments ?? [])
    const seg = (name: string) => activeSegments.size === 0 || activeSegments.has(name)

    // ── Build segments ──────────────────────────────────────────────────────

    const rb = (s: string, idx = 0) => rainbowStr(s, idx, timeOffset)
    const label = (s: string) => `${DIM}${s}${R}`

    const topLeft = rb("┌──")
    const midLeft = rb("├──")
    const bottomLeft = rb("└──")

    const ctxStats = updateContextStats(cwd, ctxPct)
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

    const issueCount = Array.isArray(issueData) ? issueData.length : null
    const prCount = Array.isArray(prListData) ? prListData.length : null
    const issueSeg =
      issueCount !== null ? formatCountSegment(issueCount, "issue", "issues", 10, 25) : ""
    const prSeg = prCount !== null ? formatCountSegment(prCount, "PR", "PRs", 5, 12) : ""
    const ghCountSeg =
      issueCount !== null || prCount !== null ? [issueSeg, prSeg].filter(Boolean).join("  ") : ""

    const reviewDecision = prViewData?.reviewDecision ?? ""
    const commentCount = Array.isArray(prViewData?.comments) ? prViewData.comments.length : 0
    const currentState = await readProjectState(cwd)
    const stateSeg = formatProjectState(currentState)
    const reviewStatus =
      reviewDecision === "CHANGES_REQUESTED"
        ? `\x1b[91m⚠ changes requested${R}`
        : reviewDecision === "APPROVED"
          ? `\x1b[92m✓ approved${R}`
          : commentCount > 0
            ? `${DIM}💬 ${commentCount}${R}`
            : ""

    const agentTag = agentName ? `${a4}[${agentName}]${R}` : ""
    const vimTag = vimMode ? formatVimMode(vimMode) : ""
    const timeSeg = `${DIM}${formatTime()}${R}`

    // ── Effective settings indicators ───────────────────────────────────────
    const settingsParts: string[] = []
    if (effective) {
      if (effective.autoContinue) settingsParts.push(`\x1b[92m⟳ auto${R}`)
      if (effective.ambitionMode === "aggressive") settingsParts.push(`\x1b[93m⚡ aggressive${R}`)
      if (effective.ambitionMode === "creative") settingsParts.push(`\x1b[95m✦ creative${R}`)
      if (effective.ambitionMode === "reflective") settingsParts.push(`\x1b[96m🪞 reflective${R}`)
      if (effective.speak) settingsParts.push(`\x1b[96m🔊 narrator${R}`)
    }
    const settingsSeg = settingsParts.join(" ")

    // ── Assemble ────────────────────────────────────────────────────────────

    const line1Groups = joinGroups([
      seg("repo") ? `${label("repo")} ${a2}${shortCwd}${R}` : "",
      seg("git") && gitInfo ? `${label("git")} ${gitInfo}` : "",
      seg("pr") && reviewStatus ? `${label("pr")} ${reviewStatus}` : "",
    ])
    const line2Groups = joinGroups([
      seg("model") ? `${label("model")} ${rb(model)}` : "",
      seg("ctx") && ctxPct > 0 ? `${label("ctx")} ${ctxSeg}` : "",
    ])
    const modeSeg = [agentTag, vimTag].filter(Boolean).join(" ")
    const line3Groups = joinGroups([
      seg("state") ? `${label("state")} ${stateSeg}` : "",
      seg("backlog") && ghCountSeg ? `${label("backlog")} ${ghCountSeg}` : "",
      seg("mode") && modeSeg ? `${label("mode")} ${modeSeg}` : "",
      seg("flags") && settingsSeg ? `${label("flags")} ${settingsSeg}` : "",
      seg("time") ? `${label("time")} ${timeSeg}` : "",
    ])

    const line1 = `${topLeft} ${line1Groups || `${DIM}─${R}`}`
    const line2 = `${midLeft} ${line2Groups || `${DIM}─${R}`}`
    const line3 = `${bottomLeft} ${line3Groups || `${DIM}─${R}`}`

    console.log(`${line1}\n${line2}\n${line3}`)
  },
}
