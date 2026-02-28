#!/usr/bin/env bun
// PostToolUse hook: Inject PR context after git checkout / gh pr checkout
// Detects branch switches via Bash tool, looks up the associated PR,
// and injects PR body, merge status, and last comment as additionalContext.

import { isShellTool } from "./hook-utils.ts"

const input = await Bun.stdin.json().catch(() => null)
if (!input) process.exit(0)

const toolName: string = input.tool_name ?? ""
const cwd: string = input.cwd ?? ""
const command: string = input.tool_input?.command ?? ""

if (!isShellTool(toolName) || !cwd || !command) process.exit(0)

// Detect checkout patterns:
//   git checkout <branch>  /  git checkout -b <branch>
//   gh pr checkout <number-or-branch>
const isCheckout =
  /(?:^|;|&&|\|\|)\s*git checkout\b/.test(command) ||
  /(?:^|;|&&|\|\|)\s*gh pr checkout\b/.test(command)

if (!isCheckout) process.exit(0)

// Get current branch after checkout
function run(cmd: string, cwd: string): string {
  try {
    const proc = Bun.spawnSync(["bash", "-c", cmd], { cwd })
    return new TextDecoder().decode(proc.stdout).trim()
  } catch {
    return ""
  }
}

const branch = run("git branch --show-current", cwd)
if (!branch) process.exit(0)

// Fetch PR JSON for this branch (gh times out after ~5s itself)
interface GhPr {
  number: number
  title: string
  state: string
  mergeable: string
  mergeStateStatus: string
  reviewDecision: string
  body: string
  comments: Array<{ author?: { login?: string }; createdAt?: string; body?: string }>
}

function ghJson(args: string[]): GhPr | null {
  try {
    const proc = Bun.spawnSync(["gh", ...args], { cwd })
    const out = new TextDecoder().decode(proc.stdout).trim()
    return out ? JSON.parse(out) : null
  } catch {
    return null
  }
}

const pr = ghJson([
  "pr",
  "view",
  branch,
  "--json",
  "number,title,state,mergeable,mergeStateStatus,body,comments,reviewDecision",
])

if (!pr?.number) process.exit(0)

// Build context
const lines: string[] = []

lines.push(`PR #${pr.number}: ${pr.title} [${pr.state}]`)

if (pr.reviewDecision && pr.reviewDecision !== "null") {
  lines.push(`Review: ${pr.reviewDecision}`)
}
if (pr.mergeStateStatus && pr.mergeStateStatus !== "null") {
  lines.push(`Merge status: ${pr.mergeStateStatus}`)
}
if (pr.mergeable && pr.mergeable !== "null" && pr.mergeable !== "UNKNOWN") {
  lines.push(`Mergeable: ${pr.mergeable}`)
}

if (pr.body) {
  const body = pr.body.length > 800 ? `${pr.body.slice(0, 800)}...` : pr.body
  lines.push("", "--- PR Description ---", body)
}

if (pr.comments?.length) {
  const last = pr.comments[pr.comments.length - 1]
  if (last) {
    const who = last.author?.login ?? "unknown"
    const when = last.createdAt ?? ""
    const text = last.body ?? ""
    const truncated = text.length > 600 ? `${text.slice(0, 600)}...` : text
    lines.push("", `--- Last Comment ---`, `[${who} at ${when}]`, truncated)
  }
}

const context = lines.join("\n")

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: context,
    },
  })
)
