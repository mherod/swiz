#!/usr/bin/env bun
// PostToolUse hook: Inject PR context after git checkout / gh pr checkout
// Detects branch switches via Bash tool, looks up the associated PR,
// and injects PR body, merge status, and last comment as additionalContext.
//
// Dual-mode: exports a SwizShellHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { ghJson, git } from "../src/git-helpers.ts"
import { runSwizHookAsMain, type SwizHookOutput, type SwizShellHook } from "../src/SwizHook.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { GH_PR_CHECKOUT_RE, GIT_CHECKOUT_RE } from "../src/utils/git-utils.ts"
import { type ShellHookInput, shellHookInputSchema } from "./schemas.ts"

/** Same envelope as `emitContext` in hook-utils, without `process.exit` (safe for inline dispatch). */
function postToolUseAdditionalContext(context: string): SwizHookOutput {
  return {
    systemMessage: context,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: context,
    },
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

const posttoolusPrContext: SwizShellHook = {
  name: "posttooluse-pr-context",
  event: "postToolUse",
  matcher: "Bash",
  timeout: 10,

  async run(input: ShellHookInput): Promise<SwizHookOutput> {
    const parsed = shellHookInputSchema.safeParse(input)
    if (!parsed.success) return {}

    const toolName: string = parsed.data.tool_name ?? ""
    const cwd: string = parsed.data.cwd ?? ""
    const command: string = (parsed.data.tool_input?.command as string) ?? ""

    if (!isShellTool(toolName) || !cwd || !command) return {}

    // Detect checkout patterns:
    //   git checkout <branch>  /  git checkout -b <branch>
    //   gh pr checkout <number-or-branch>
    const isCheckout = GIT_CHECKOUT_RE.test(command) || GH_PR_CHECKOUT_RE.test(command)

    if (!isCheckout) return {}

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

    return postToolUseAdditionalContext(context)
  },
}

export default posttoolusPrContext

if (import.meta.main) {
  await runSwizHookAsMain(posttoolusPrContext)
}
