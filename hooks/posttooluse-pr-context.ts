#!/usr/bin/env bun
// PostToolUse hook: Inject PR context after git checkout / gh pr checkout
// Detects branch switches via Bash tool, looks up the associated PR,
// and injects PR body, merge status, and last comment as additionalContext.
//
// Dual-mode: exports a SwizShellHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { ghJson, git } from "../src/git-helpers.ts"
import { runSwizHookAsMain, type SwizHookOutput, type SwizShellHook } from "../src/SwizHook.ts"
import { type ShellHookInput, shellHookInputSchema } from "../src/schemas.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { GH_PR_CHECKOUT_RE, GIT_CHECKOUT_RE } from "../src/utils/git-utils.ts"
import { hsoContextEvent } from "../src/utils/hook-specific-output.ts"

/** Same envelope as `emitContext` in hook-utils, without `process.exit` (safe for inline dispatch). */
function postToolUseAdditionalContext(context: string): SwizHookOutput {
  return {
    systemMessage: context,
    suppressOutput: true,
    hookSpecificOutput: hsoContextEvent("PostToolUse", context),
  }
}

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

function getValidatedCheckout(input: ShellHookInput): { cwd: string; command: string } | null {
  const parsed = shellHookInputSchema.safeParse(input)
  if (!parsed.success) return null

  const { tool_name, cwd, tool_input } = parsed.data
  if (!tool_name || !cwd || !tool_input) return null
  if (!isShellTool(tool_name)) return null

  const command = tool_input.command as string
  if (!command) return null

  if (!GIT_CHECKOUT_RE.test(command) && !GH_PR_CHECKOUT_RE.test(command)) return null

  return { cwd, command }
}

function getPrStatusLines(pr: GhPr): string[] {
  const lines = [`PR #${pr.number}: ${pr.title} [${pr.state}]`]
  if (pr.reviewDecision && pr.reviewDecision !== "null") {
    lines.push(`Review: ${pr.reviewDecision}`)
  }
  if (pr.mergeStateStatus && pr.mergeStateStatus !== "null") {
    lines.push(`Merge status: ${pr.mergeStateStatus}`)
  }
  if (pr.mergeable && pr.mergeable !== "null" && pr.mergeable !== "UNKNOWN") {
    lines.push(`Mergeable: ${pr.mergeable}`)
  }
  return lines
}

function formatReviewBody(body: string | undefined): string {
  if (!body) return ""
  return `: ${body.length > 300 ? `${body.slice(0, 300)}...` : body}`
}

function getPrReviewsLines(pr: GhPr): string[] {
  const reviews = pr.latestReviews || []
  const approvals = reviews.filter((r) => r.state === "APPROVED" || r.state === "CHANGES_REQUESTED")
  if (!approvals.length) return []

  const lines = ["", "--- Reviews ---"]
  for (const r of approvals) {
    const who = r.author?.login || "unknown"
    const when = r.submittedAt || ""
    lines.push(`[${r.state}] @${who} (${when})${formatReviewBody(r.body)}`)
  }
  return lines
}

function getPrDescriptionLines(pr: GhPr): string[] {
  if (!pr.body) return []
  const body = pr.body.length > 800 ? `${pr.body.slice(0, 800)}...` : pr.body
  return ["", "--- PR Description ---", body]
}

function getPrLastCommentLines(pr: GhPr): string[] {
  if (!pr.comments?.length) return []
  const last = pr.comments[pr.comments.length - 1]
  if (!last) return []

  const who = last.author?.login || "unknown"
  const when = last.createdAt || ""
  const text = last.body || ""
  const truncated = text.length > 600 ? `${text.slice(0, 600)}...` : text
  return ["", `--- Last Comment ---`, `[${who} at ${when}]`, truncated]
}

const posttoolusPrContext: SwizShellHook = {
  name: "posttooluse-pr-context",
  event: "postToolUse",
  matcher: "Bash",
  timeout: 10,

  async run(input: ShellHookInput): Promise<SwizHookOutput> {
    const validated = getValidatedCheckout(input)
    if (!validated) return {}

    const { cwd } = validated
    const branch = await git(["branch", "--show-current"], cwd)
    if (!branch) return {}

    // Fetch PR JSON for this branch (gh times out after ~5s itself)
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

    if (!pr?.number) return {}

    const lines = [
      ...getPrStatusLines(pr),
      ...getPrReviewsLines(pr),
      ...getPrDescriptionLines(pr),
      ...getPrLastCommentLines(pr),
    ]

    return postToolUseAdditionalContext(lines.join("\n"))
  },
}

export default posttoolusPrContext

if (import.meta.main) {
  await runSwizHookAsMain(posttoolusPrContext)
}
