// Status line for Claude Code — outputs a rich ANSI-colored status bar.
// Receives a JSON object via stdin with model, workspace, context window, and cost info.
// Uses time-based rainbow cycling so colors shift on each render.

import { existsSync, readFileSync, statSync } from "node:fs"
import { basename, dirname } from "node:path"
import { getEffectiveSwizSettings, readSwizSettings } from "../settings.ts"
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

// ANSI helpers
const R = "\x1b[0m"
const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"

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

function progressBar(pct: number, width = 10): string {
  const filled = Math.round((pct / 100) * width)
  const color = colorForPct(pct)
  return `${color}${"█".repeat(filled)}${DIM}${"░".repeat(width - filled)}${R}`
}

function shortenPath(dir: string): string {
  return basename(dir)
}

// Resolve git metadata by walking up from cwd.
function resolveGitPaths(cwd: string): { gitDir: string; workTree: string } | null {
  let dir = cwd
  while (true) {
    const candidate = `${dir}/.git`
    if (existsSync(candidate)) {
      try {
        const st = statSync(candidate)
        if (st.isDirectory()) return { gitDir: candidate, workTree: dir }
        const content = readFileSync(candidate, "utf8").trim()
        if (content.startsWith("gitdir: ")) {
          return { gitDir: content.slice("gitdir: ".length).trim(), workTree: dir }
        }
      } catch {
        /* fall through */
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

async function getGitBranchAndInfo(cwd: string): Promise<{ branch: string; info: string }> {
  const git = resolveGitPaths(cwd)
  if (!git) return { branch: "", info: "" }

  let branch = ""
  try {
    const head = (await Bun.file(`${git.gitDir}/HEAD`).text()).trim()
    if (head.startsWith("ref: refs/heads/")) {
      branch = head.slice("ref: refs/heads/".length)
    } else if (/^[a-f0-9]{7,40}$/i.test(head)) {
      branch = `detached@${head.slice(0, 7)}`
    }
  } catch {
    /* no branch */
  }
  if (!branch) return { branch: "", info: "" }

  let ahead = 0
  let behind = 0
  let staged = 0
  let unstaged = 0
  let untracked = 0
  let conflicts = 0
  let stash = 0
  let parsedStatus = false
  let changedFallback = 0

  try {
    const proc = Bun.spawnSync(["git", "status", "--porcelain=2", "--branch"], {
      cwd: git.workTree,
      stdout: "pipe",
      stderr: "ignore",
    })
    if (proc.exitCode === 0) {
      const out = new TextDecoder().decode(proc.stdout).trim()
      const lines = out ? out.split("\n") : []

      for (const line of lines) {
        if (line.startsWith("# branch.ab ")) {
          const match = line.match(/\+(\d+)\s+-(\d+)/)
          if (match) {
            ahead = Number(match[1] ?? "0")
            behind = Number(match[2] ?? "0")
          }
          continue
        }

        if (line.startsWith("1 ") || line.startsWith("2 ")) {
          const xy = line.split(" ")[1] ?? ".."
          if (xy[0] && xy[0] !== ".") staged++
          if (xy[1] && xy[1] !== ".") unstaged++
          continue
        }

        if (line.startsWith("u ")) {
          conflicts++
          continue
        }

        if (line.startsWith("? ")) {
          untracked++
        }
      }
      parsedStatus = true
    }
  } catch {
    /* parse fallback below */
  }

  if (!parsedStatus) {
    try {
      const proc = Bun.spawnSync(["git", "status", "--porcelain"], {
        cwd: git.workTree,
        stdout: "pipe",
        stderr: "ignore",
      })
      const out = new TextDecoder().decode(proc.stdout).trim()
      changedFallback = out ? out.split("\n").length : 0
    } catch {
      /* assume clean */
    }
  }

  try {
    const proc = Bun.spawnSync(["git", "stash", "list", "--format=%gd"], {
      cwd: git.workTree,
      stdout: "pipe",
      stderr: "ignore",
    })
    if (proc.exitCode === 0) {
      const out = new TextDecoder().decode(proc.stdout).trim()
      stash = out ? out.split("\n").length : 0
    }
  } catch {
    /* no stash info */
  }

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

async function ghJson<T>(args: string[]): Promise<T | null> {
  return new Promise((resolve) => {
    const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "ignore" })
    const timeout = setTimeout(() => {
      proc.kill()
      resolve(null)
    }, 2000)
    new Response(proc.stdout)
      .text()
      .then((out: string) => {
        clearTimeout(timeout)
        try {
          resolve(JSON.parse(out))
        } catch {
          resolve(null)
        }
      })
      .catch(() => {
        clearTimeout(timeout)
        resolve(null)
      })
  })
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

function joinGroups(groups: Array<string | null | undefined>): string {
  return groups.filter(Boolean).join(` ${DIM}│${R} `)
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
        ? ghJson<{ reviewDecision?: string; comments?: unknown[] }>([
            "pr",
            "view",
            branch,
            "--json",
            "reviewDecision,comments",
          ])
        : null
    )

    const [gitResult, issueData, prListData, prViewData, swizSettings] = await Promise.all([
      gitPromise,
      ghJson<unknown[]>(["issue", "list", "--state", "open", "--json", "number", "--limit", "100"]),
      ghJson<unknown[]>(["pr", "list", "--state", "open", "--json", "number", "--limit", "100"]),
      prViewPromise,
      readSwizSettings().catch(() => null),
    ])

    const { info: gitInfo } = gitResult

    // ── Build segments ──────────────────────────────────────────────────────

    const rb = (s: string, idx = 0) => rainbowStr(s, idx, timeOffset)
    const label = (s: string) => `${DIM}${s}${R}`

    const topLeft = rb("┌──")
    const midLeft = rb("├──")
    const bottomLeft = rb("└──")

    const ctxBar = progressBar(ctxPct)
    const ctxColor = colorForPct(ctxPct)
    const tokenStr = ctxTokens > 0 ? ` ${DIM}${formatTokens(ctxTokens)}${R}` : ""
    const ctxSeg = `${ctxBar}${ctxColor}${ctxPct.toFixed(0)}%${R}${tokenStr}`

    const issueCount = Array.isArray(issueData) ? issueData.length : null
    const prCount = Array.isArray(prListData) ? prListData.length : null
    const issueSeg =
      issueCount !== null ? formatCountSegment(issueCount, "issue", "issues", 10, 25) : ""
    const prSeg = prCount !== null ? formatCountSegment(prCount, "PR", "PRs", 5, 12) : ""
    const ghCountSeg =
      issueCount !== null || prCount !== null ? [issueSeg, prSeg].filter(Boolean).join("  ") : ""

    const reviewDecision = prViewData?.reviewDecision ?? ""
    const commentCount = Array.isArray(prViewData?.comments) ? prViewData.comments.length : 0
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
    const effective = swizSettings
      ? getEffectiveSwizSettings(swizSettings, input.session_id ?? null)
      : null

    const settingsParts: string[] = []
    if (effective) {
      if (effective.autoContinue) settingsParts.push(`\x1b[92m⟳ auto${R}`)
      if (effective.ambitionMode === "aggressive") settingsParts.push(`\x1b[93m⚡ aggressive${R}`)
      if (effective.speak) settingsParts.push(`\x1b[96m🔊 narrator${R}`)
    }
    const settingsSeg = settingsParts.join(" ")

    // ── Assemble ────────────────────────────────────────────────────────────

    const line1Groups = joinGroups([
      `${label("repo")} ${a2}${shortCwd}${R}`,
      gitInfo ? `${label("git")} ${gitInfo}` : "",
      reviewStatus ? `${label("pr")} ${reviewStatus}` : "",
    ])
    const line2Groups = joinGroups([`${label("model")} ${rb(model)}`, `${label("ctx")} ${ctxSeg}`])
    const modeSeg = [agentTag, vimTag].filter(Boolean).join(" ")
    const line3Groups = joinGroups([
      ghCountSeg ? `${label("backlog")} ${ghCountSeg}` : "",
      modeSeg ? `${label("mode")} ${modeSeg}` : "",
      settingsSeg ? `${label("flags")} ${settingsSeg}` : "",
      `${label("time")} ${timeSeg}`,
    ])

    const line1 = `${topLeft} ${line1Groups || `${DIM}─${R}`}`
    const line2 = `${midLeft} ${line2Groups || `${DIM}─${R}`}`
    const line3 = `${bottomLeft} ${line3Groups || `${DIM}─${R}`}`

    console.log(`${line1}\n${line2}\n${line3}`)
  },
}
