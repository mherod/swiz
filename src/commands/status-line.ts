// Status line for Claude Code — outputs a rich ANSI-colored status bar.
// Receives a JSON object via stdin with model, workspace, context window, and cost info.
// Uses time-based rainbow cycling so colors shift on each render.

import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname } from "node:path"
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
  const home = process.env.HOME ?? ""
  return home && dir.startsWith(home) ? "~" + dir.slice(home.length) : dir
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

async function readGitConfigValue(filePath: string, section: string, key: string): Promise<string> {
  try {
    const text = await Bun.file(filePath).text()
    const header = new RegExp(`^\\[${section}\\]`, "im")
    const nextSec = /^\[/m
    const match = header.exec(text)
    if (!match) return ""

    const body = text.slice(match.index + match[0].length)
    const nextMatch = nextSec.exec(body)
    const sectionBody = nextMatch ? body.slice(0, nextMatch.index) : body

    const kvMatch = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, "im").exec(sectionBody)
    return kvMatch ? kvMatch[1]!.trim() : ""
  } catch {
    return ""
  }
}

async function getGitBranchAndInfo(cwd: string): Promise<{ branch: string; info: string }> {
  const git = resolveGitPaths(cwd)
  if (!git) return { branch: "", info: "" }

  let branch = ""
  try {
    const head = (await Bun.file(`${git.gitDir}/HEAD`).text()).trim()
    if (head.startsWith("ref: refs/heads/")) branch = head.slice("ref: refs/heads/".length)
  } catch {
    /* no branch */
  }
  if (!branch) return { branch: "", info: "" }

  let changed = 0
  try {
    const proc = Bun.spawnSync(["git", "status", "--porcelain"], {
      cwd: git.workTree,
      stdout: "pipe",
      stderr: "ignore",
    })
    const out = new TextDecoder().decode(proc.stdout).trim()
    changed = out ? out.split("\n").length : 0
  } catch {
    /* assume clean */
  }

  const dirty = changed > 0
  const branchColor = dirty ? "\x1b[93m" : "\x1b[92m"
  const icon = dirty ? "±" : "✦"
  const changedStr = dirty ? ` ${DIM}${changed}~${R}` : ""

  return { branch, info: ` ${DIM}on${R} ${branchColor}${icon} ${branch}${R}${changedStr}` }
}

async function readGitUserName(cwd: string): Promise<string> {
  const git = resolveGitPaths(cwd)
  const home = process.env.HOME ?? "~"
  const [local, global_] = await Promise.all([
    git ? readGitConfigValue(`${git.gitDir}/config`, "user", "name") : Promise.resolve(""),
    readGitConfigValue(`${home}/.gitconfig`, "user", "name"),
  ])
  const full = local || global_
  if (full) return full.split(" ")[0]!
  return process.env.USER ?? "me"
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
    const a1 = fg256(RAINBOW[timeOffset]!)
    const a2 = fg256(RAINBOW[(timeOffset + 6) % RL]!)
    const a3 = fg256(RAINBOW[(timeOffset + 12) % RL]!)
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

    const [gitResult, issueData, prListData, firstName, prViewData] = await Promise.all([
      gitPromise,
      ghJson<unknown[]>(["issue", "list", "--state", "open", "--json", "number", "--limit", "100"]),
      ghJson<unknown[]>(["pr", "list", "--state", "open", "--json", "number", "--limit", "100"]),
      readGitUserName(cwd),
      prViewPromise,
    ])

    const { info: gitInfo } = gitResult

    // ── Build segments ──────────────────────────────────────────────────────

    const br = (s: string) => `${a3}${s}${R}`
    const rb = (s: string, idx = 0) => rainbowStr(s, idx, timeOffset)

    const topLeft = rb("┌──")
    const midLeft = rb("├──")
    const midJoin = rb("─", 3)
    const bottomLeft = rb("└──")

    const ctxBar = progressBar(ctxPct)
    const ctxColor = colorForPct(ctxPct)
    const tokenStr = ctxTokens > 0 ? ` ${DIM}${formatTokens(ctxTokens)}${R}` : ""
    const ctxSeg = `ctx ${ctxBar}${ctxColor}${ctxPct.toFixed(0)}%${R}${tokenStr}`

    const sessionSeg = input.session_id ? `${DIM}session ${input.session_id.slice(0, 8)}${R}` : ""

    const issueCount = Array.isArray(issueData) ? issueData.length : null
    const prCount = Array.isArray(prListData) ? prListData.length : null
    const ghCountSeg =
      issueCount !== null || prCount !== null
        ? [
            issueCount !== null
              ? `${DIM}${issueCount} issue${issueCount !== 1 ? "s" : ""}${R}`
              : "",
            prCount !== null ? `${DIM}${prCount} PR${prCount !== 1 ? "s" : ""}${R}` : "",
          ]
            .filter(Boolean)
            .join("  ")
        : ""

    const reviewDecision = prViewData?.reviewDecision ?? ""
    const commentCount = Array.isArray(prViewData?.comments) ? prViewData.comments.length : 0
    const reviewSeg =
      reviewDecision === "CHANGES_REQUESTED"
        ? ` \x1b[91m⚠ changes requested${R}`
        : reviewDecision === "APPROVED"
          ? ` \x1b[92m✓ approved${R}`
          : commentCount > 0
            ? ` ${DIM}💬 ${commentCount}${R}`
            : ""

    const agentTag = agentName ? `${a4}[${agentName}]${R}` : ""
    const vimTag = vimMode ? formatVimMode(vimMode) : ""
    const timeSeg = `${DIM}${formatTime()}${R}`

    // ── Assemble ────────────────────────────────────────────────────────────

    const line3Parts = [sessionSeg, ghCountSeg, agentTag, vimTag, timeSeg].filter(Boolean)

    const line1 = `${topLeft}${br("[")}${a1}${firstName}${R}${br("]")}${midJoin}${br("[")}${a2}${shortCwd}${R}${br("]")}${gitInfo}${reviewSeg}`
    const line2 = `${midLeft} ${rb(model)}  ${ctxSeg}`
    const line3 = `${bottomLeft} ${line3Parts.length ? line3Parts.join("  ") : DIM + "─" + R}`

    console.log(`${line1}\n${line2}\n${line3}`)
  },
}
