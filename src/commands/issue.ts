import { getRepoSlug, issueState } from "../git-helpers.ts"
import { getIssueStore } from "../issue-store.ts"
import type { Command } from "../types.ts"

function usage(): string {
  return (
    "Usage: swiz issue <subcommand> <number> [options]\n" +
    "Subcommands: close, comment, resolve\n" +
    "  swiz issue close <number>\n" +
    "  swiz issue comment <number> --body <text>\n" +
    "  swiz issue resolve <number> [--body <text>]"
  )
}

async function closeIssue(number: string): Promise<void> {
  const cwd = process.cwd()
  const state = await issueState(number, cwd)

  if (state !== "OPEN") {
    console.log(`  Issue #${number} is already ${state ?? "unknown"} — skipping close.`)
    return
  }

  const proc = Bun.spawn(["gh", "issue", "close", number], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  })
  await proc.exited
  if (proc.exitCode !== 0) {
    // Queue mutation for offline replay
    const slug = await getRepoSlug(cwd)
    if (slug) {
      try {
        getIssueStore().queueMutation(slug, { type: "close", number: parseInt(number, 10) })
      } catch {
        // Non-fatal — mutation queue is best-effort
      }
    }
    throw new Error(`gh issue close failed with exit code ${proc.exitCode}`)
  }

  // Remove from cache on successful close
  const slug = await getRepoSlug(cwd)
  if (slug) {
    try {
      getIssueStore().removeIssue(slug, parseInt(number, 10))
    } catch {
      // Non-fatal — cache cleanup is best-effort
    }
  }
}

async function commentOnIssue(number: string, body: string): Promise<void> {
  const cwd = process.cwd()
  const state = await issueState(number, cwd)

  if (state !== "OPEN") {
    console.log(`  Issue #${number} is already ${state ?? "unknown"} — skipping comment.`)
    return
  }

  const proc = Bun.spawn(["gh", "issue", "comment", number, "--body", body], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  })
  await proc.exited
  if (proc.exitCode !== 0) {
    // Queue mutation for offline replay
    const slug = await getRepoSlug(cwd)
    if (slug) {
      try {
        getIssueStore().queueMutation(slug, {
          type: "comment",
          number: parseInt(number, 10),
          body,
        })
      } catch {
        // Non-fatal
      }
    }
    throw new Error(`gh issue comment failed with exit code ${proc.exitCode}`)
  }
}

interface ResolveResult {
  issueNumber: string
  finalState: "OPEN" | "CLOSED" | null
  alreadyClosed: boolean
  commentPosted: boolean
  closedNow: boolean
}

/**
 * Idempotent issue resolution: fetches state first, then conditionally
 * comments and closes based on current status.
 *
 * - Always posts the resolution comment when a body is provided (even if
 *   already closed) so the audit trail is complete.
 * - Only calls `gh issue close` when the issue is OPEN — skips silently
 *   and reports `alreadyClosed: true` otherwise.
 * - Returns a structured result so callers can reconcile task state.
 */
async function postComment(
  number: string,
  body: string,
  cwd: string,
  slug: string | null
): Promise<void> {
  const proc = Bun.spawn(["gh", "issue", "comment", number, "--body", body], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  })
  await proc.exited
  if (proc.exitCode !== 0) {
    if (slug) {
      try {
        getIssueStore().queueMutation(slug, { type: "comment", number: parseInt(number, 10), body })
      } catch {}
    }
    throw new Error(`gh issue comment failed with exit code ${proc.exitCode}`)
  }
}

async function closeAndRemove(number: string, cwd: string, slug: string | null): Promise<void> {
  const proc = Bun.spawn(["gh", "issue", "close", number], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  })
  await proc.exited
  if (proc.exitCode !== 0) {
    if (slug) {
      try {
        getIssueStore().queueMutation(slug, { type: "close", number: parseInt(number, 10) })
      } catch {}
    }
    throw new Error(`gh issue close failed with exit code ${proc.exitCode}`)
  }
  if (slug) {
    try {
      getIssueStore().removeIssue(slug, parseInt(number, 10))
    } catch {}
  }
}

async function resolveIssue(number: string, body?: string): Promise<ResolveResult> {
  const cwd = process.cwd()
  const state = await issueState(number, cwd)
  const alreadyClosed = state !== "OPEN"
  const slug = await getRepoSlug(cwd)

  let commentPosted = false
  if (body) {
    await postComment(number, body, cwd, slug)
    commentPosted = true
  }

  let closedNow = false
  if (!alreadyClosed) {
    await closeAndRemove(number, cwd, slug)
    closedNow = true
  }

  if (alreadyClosed) {
    console.log(
      `  Issue #${number} was already ${state ?? "unknown"}.${commentPosted ? " Resolution comment posted." : ""} No close action taken.`
    )
  } else {
    console.log(
      `  Issue #${number} resolved.${commentPosted ? " Comment posted." : ""} Issue closed.`
    )
  }

  return {
    issueNumber: number,
    finalState: alreadyClosed ? state : "CLOSED",
    alreadyClosed,
    commentPosted,
    closedNow,
  }
}

function parseBodyArg(args: string[]): string | undefined {
  for (let i = 2; i < args.length; i++) {
    if ((args[i] === "--body" || args[i] === "-b") && args[i + 1]) return args[i + 1]
  }
  return undefined
}

export const issueCommand: Command = {
  name: "issue",
  description: "Interact with GitHub issues (guards against operating on closed issues)",
  usage: "swiz issue <close|comment|resolve> <number> [--body <text>]",
  options: [
    { flags: "close <number>", description: "Close an issue (skips if already closed)" },
    {
      flags: "comment <number> --body <text>",
      description: "Comment on an issue (skips if already closed)",
    },
    {
      flags: "resolve <number> [--body <text>]",
      description:
        "Idempotent resolve: fetch state, always post comment, close only if OPEN. " +
        "Reports accurate final state whether issue was open or already closed.",
    },
    { flags: "--body, -b <text>", description: "Comment body (for comment and resolve)" },
  ],
  async run(args) {
    const sub = args[0]
    const number = args[1]
    if (!sub || !number) throw new Error(`Missing arguments.\n${usage()}`)

    if (sub === "close") return closeIssue(number)

    const body = parseBodyArg(args)
    if (sub === "comment") {
      if (!body) throw new Error(`--body is required for the comment subcommand.\n${usage()}`)
      return commentOnIssue(number, body)
    }
    if (sub === "resolve") {
      await resolveIssue(number, body)
      return
    }

    throw new Error(`Unknown subcommand: ${sub}\n${usage()}`)
  },
}
