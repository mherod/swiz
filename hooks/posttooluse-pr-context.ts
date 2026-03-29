#!/usr/bin/env bun
// PostToolUse hook: Inject PR context after git checkout / gh pr checkout
// Detects branch switches via Bash tool, looks up the associated PR,
// and injects PR body, merge status, and last comment as additionalContext.

import {
  emitContext,
  GH_PR_CHECKOUT_RE,
  GIT_CHECKOUT_RE,
  ghJson,
  git,
  isShellTool,
} from "../src/utils/hook-utils.ts"

const input = await Bun.stdin.json().catch(() => null)
if (!input) process.exit(0)

const toolName: string = input.tool_name ?? ""
const cwd: string = input.cwd ?? ""
const command: string = input.tool_input?.command ?? ""

if (!isShellTool(toolName) || !cwd || !command) process.exit(0)

// Detect checkout patterns:
//   git checkout <branch>  /  git checkout -b <branch>
//   gh pr checkout <number-or-branch>
const isCheckout = GIT_CHECKOUT_RE.test(command) || GH_PR_CHECKOUT_RE.test(command)

if (!isCheckout) process.exit(0)

const branch = await git(["branch", "--show-current"], cwd)
if (!branch) process.exit(0)

// Fetch PR JSON for this branch (gh times out after ~5s itself)
interface GhReview {
  author?: { login?: string }
  state?: string
  submittedAt?: string
  body?: string
}

interface GhPr {
  number: number
  title: string
  state: string
  mergeable: string
  mergeStateStatus: string
  reviewDecision: string
  body: string
  comments: Array<{ author?: { login?: string }; createdAt?: string; body?: string }>
  latestReviews: GhReview[]
}

const pr = await ghJson<GhPr>(
  [
    "pr",
    "view",
    branch,
    "--json",
    "number,title,state,mergeable,mergeStateStatus,body,comments,reviewDecision,latestReviews",
  ],
  cwd
)

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

// Render individual review details (approvals, changes requested, etc.)
const approvals = (pr.latestReviews ?? []).filter(
  (r) => r.state === "APPROVED" || r.state === "CHANGES_REQUESTED"
)
if (approvals.length > 0) {
  lines.push("", "--- Reviews ---")
  for (const r of approvals) {
    const who = r.author?.login ?? "unknown"
    const when = r.submittedAt ?? ""
    const reviewBody = r.body
      ? `: ${r.body.length > 300 ? `${r.body.slice(0, 300)}...` : r.body}`
      : ""
    lines.push(`[${r.state}] @${who} (${when})${reviewBody}`)
  }
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

await emitContext("PostToolUse", context)
