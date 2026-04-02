import { debugLog } from "../debug.ts"
import { acquireGhSlot } from "../gh-rate-limit.ts"
import { getRepoSlug, issueState } from "../git-helpers.ts"
import { getIssueStore, isGraphQLRateLimited } from "../issue-store.ts"
import { syncUpstreamState } from "../issue-store-sync.ts"
import type { Command } from "../types.ts"

/** Close an issue via REST API fallback when GraphQL is rate-limited. */
async function closeIssueViaRest(slug: string, number: string, cwd: string): Promise<boolean> {
  debugLog(`[swiz] REST_FALLBACK closing issue #${number} on ${slug}`)
  const proc = Bun.spawn(
    ["gh", "api", `repos/${slug}/issues/${number}`, "-X", "PATCH", "-f", "state=closed"],
    { cwd, stdout: "pipe", stderr: "pipe" }
  )
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return proc.exitCode === 0
}

/** Comment on an issue via REST API fallback when GraphQL is rate-limited. */
async function commentViaRest(
  slug: string,
  number: string,
  body: string,
  cwd: string
): Promise<boolean> {
  debugLog(`[swiz] REST_FALLBACK commenting on issue #${number} on ${slug}`)
  const proc = Bun.spawn(
    ["gh", "api", `repos/${slug}/issues/${number}/comments`, "-f", `body=${body}`],
    { cwd, stdout: "pipe", stderr: "pipe" }
  )
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return proc.exitCode === 0
}

function usage(): string {
  return (
    "Usage: swiz issue <subcommand> [options]\n" +
    "Subcommands: close, comment, resolve, cache-bust, sync, list\n" +
    "  swiz issue close <number>\n" +
    "  swiz issue comment <number> --body <text>\n" +
    "  swiz issue resolve <number> [--body <text>]\n" +
    "  swiz issue cache-bust [--repo <slug>]\n" +
    "  swiz issue sync [<repo>]\n" +
    "  swiz issue list [<repo>]"
  )
}

function removeFromStore(slug: string | null, number: string): void {
  if (!slug) return
  try {
    getIssueStore().removeIssue(slug, parseInt(number, 10))
  } catch {}
}

async function handleCloseFailure(
  slug: string | null,
  number: string,
  stderr: string,
  exitCode: number,
  cwd: string
): Promise<void> {
  if (isGraphQLRateLimited(stderr) && slug) {
    if (await closeIssueViaRest(slug, number, cwd)) {
      removeFromStore(slug, number)
      return
    }
  }
  if (slug) {
    try {
      getIssueStore().queueMutation(slug, { type: "close", number: parseInt(number, 10) })
    } catch {}
  }
  throw new Error(`gh issue close failed with exit code ${exitCode}`)
}

async function closeIssue(number: string): Promise<void> {
  const cwd = process.cwd()
  const state = await issueState(number, cwd)
  if (state !== "OPEN") {
    console.log(`  Issue #${number} is already ${state ?? "unknown"} — skipping close.`)
    return
  }

  const slug = await getRepoSlug(cwd)
  await acquireGhSlot()
  const proc = Bun.spawn(["gh", "issue", "close", number], { cwd, stdout: "pipe", stderr: "pipe" })
  const [, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  if (proc.exitCode !== 0) {
    await handleCloseFailure(slug, number, stderr, proc.exitCode ?? 1, cwd)
    return
  }
  removeFromStore(slug, number)
}

async function commentOnIssue(number: string, body: string): Promise<void> {
  const cwd = process.cwd()
  const state = await issueState(number, cwd)

  if (state !== "OPEN") {
    console.log(`  Issue #${number} is already ${state ?? "unknown"} — skipping comment.`)
    return
  }

  const slug = await getRepoSlug(cwd)
  await acquireGhSlot()
  const proc = Bun.spawn(["gh", "issue", "comment", number, "--body", body], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  if (proc.exitCode !== 0) {
    // REST API fallback on GraphQL rate-limit
    if (isGraphQLRateLimited(stderr) && slug) {
      if (await commentViaRest(slug, number, body, cwd)) return
    }

    if (slug) {
      try {
        getIssueStore().queueMutation(slug, { type: "comment", number: parseInt(number, 10), body })
      } catch {}
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
  await acquireGhSlot()
  const proc = Bun.spawn(["gh", "issue", "comment", number, "--body", body], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  if (proc.exitCode === 0) return

  // REST API fallback on GraphQL rate-limit
  if (isGraphQLRateLimited(stderr) && slug) {
    if (await commentViaRest(slug, number, body, cwd)) return
  }

  if (slug) {
    try {
      getIssueStore().queueMutation(slug, { type: "comment", number: parseInt(number, 10), body })
    } catch {}
  }
  throw new Error(`gh issue comment failed with exit code ${proc.exitCode}`)
}

async function closeAndRemove(number: string, cwd: string, slug: string | null): Promise<void> {
  await acquireGhSlot()
  const proc = Bun.spawn(["gh", "issue", "close", number], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  if (proc.exitCode !== 0) {
    // REST API fallback on GraphQL rate-limit
    if (isGraphQLRateLimited(stderr) && slug) {
      if (await closeIssueViaRest(slug, number, cwd)) {
        try {
          getIssueStore().removeIssue(slug, parseInt(number, 10))
        } catch {}
        return
      }
    }

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

async function handleCacheBust(args: string[]): Promise<void> {
  const repoFlag = args.indexOf("--repo")
  const cwd = process.cwd()
  const slug = repoFlag >= 0 && args[repoFlag + 1] ? args[repoFlag + 1] : await getRepoSlug(cwd)
  const store = getIssueStore()
  if (slug) {
    store.clearCachedData(slug)
    console.log(`  Cache cleared for ${slug}`)
  } else {
    store.clearAllCachedData()
    console.log("  All cached data cleared")
  }
}

async function handleSync(args: string[]): Promise<void> {
  const cwd = process.cwd()
  let repo: string | null = args[1] ?? null
  if (!repo) {
    repo = await getRepoSlug(cwd)
  }
  if (!repo) {
    throw new Error(
      `Repo required. Usage: swiz issue sync [<repo>]\nOr run this in a git repo with an origin.`
    )
  }

  console.log(`🔄 Syncing upstream state for ${repo}...`)
  const result = await syncUpstreamState(repo, cwd)

  const r = result
  const allChanges = [
    ...r.issues.changes,
    ...r.pullRequests.changes,
    ...r.ciStatuses.changes,
    ...r.labels.changes,
    ...r.milestones.changes,
    ...r.branchCi.changes,
    ...r.prBranchDetail.changes,
    ...r.branchProtection.changes,
  ]
  const totalUnchanged =
    r.issues.skipped + r.pullRequests.skipped + r.labels.skipped + r.milestones.skipped

  if (allChanges.length === 0 && totalUnchanged > 0) {
    console.log(`✅ Already up to date (${totalUnchanged} entities unchanged)`)
    return
  }

  console.log("✅ Sync complete:\n")

  type Row = [string, string]
  const rows: Row[] = []
  type ChangeList = { changes: { kind: string; key: string; reason: string }[] }
  const fmtEntity = (
    name: string,
    b: { upserted: number; removed: number; skipped: number } & ChangeList
  ) => {
    if (b.upserted === 0 && b.removed === 0 && b.skipped === 0) return
    const parts: string[] = []
    if (b.upserted > 0) parts.push(`\x1b[32m+${b.upserted}\x1b[0m`)
    if (b.removed > 0) parts.push(`\x1b[31m-${b.removed}\x1b[0m`)
    if (b.skipped > 0) parts.push(`\x1b[2m${b.skipped} unchanged\x1b[0m`)
    rows.push([name, parts.join("  ")])
    for (const c of b.changes) {
      const icon =
        c.kind === "new"
          ? "\x1b[32m+\x1b[0m"
          : c.kind === "removed"
            ? "\x1b[31m-\x1b[0m"
            : "\x1b[33m~\x1b[0m"
      rows.push(["", `  ${icon} ${c.key} \x1b[2m${c.reason}\x1b[0m`])
    }
  }
  const fmtTracked = (name: string, b: { upserted: number } & ChangeList) => {
    if (b.upserted === 0) return
    rows.push([name, `\x1b[32m+${b.upserted}\x1b[0m`])
    for (const c of b.changes) {
      const icon = c.kind === "new" ? "\x1b[32m+\x1b[0m" : "\x1b[33m~\x1b[0m"
      rows.push(["", `  ${icon} ${c.key} \x1b[2m${c.reason}\x1b[0m`])
    }
  }
  fmtEntity("Issues", r.issues)
  fmtEntity("PRs", r.pullRequests)
  fmtTracked("CI statuses", r.ciStatuses)
  if (r.comments.upserted > 0) rows.push(["Comments", `\x1b[32m+${r.comments.upserted}\x1b[0m`])
  fmtEntity("Labels", r.labels)
  fmtEntity("Milestones", r.milestones)
  fmtTracked("Branch CI", r.branchCi)
  fmtTracked("PR detail", r.prBranchDetail)
  fmtTracked("Protection", r.branchProtection)

  if (rows.length === 0) return
  const maxLabel = Math.max(...rows.map(([l]) => l.length))
  for (const [label, value] of rows) {
    console.log(`  ${label.padEnd(maxLabel)}  ${value}`)
  }
}

async function handleList(args: string[]): Promise<void> {
  const cwd = process.cwd()
  let repo: string | null = args[1] ?? null
  if (!repo) {
    repo = await getRepoSlug(cwd)
  }
  if (!repo) {
    throw new Error(
      `Repo required. Usage: swiz issue list [<repo>]\nOr run this in a git repo with an origin.`
    )
  }

  const store = getIssueStore()
  // Use Number.MAX_SAFE_INTEGER to get all cached items regardless of TTL
  const issues = store.listIssues<{ number: number; title: string; state?: string }>(
    repo,
    Number.MAX_SAFE_INTEGER
  )
  const prs = store.listPullRequests<{ number: number; title: string; state?: string }>(
    repo,
    Number.MAX_SAFE_INTEGER
  )

  const openIssues = issues.filter((i) => i.state?.toLowerCase() === "open")
  const openPrs = prs.filter((pr) => pr.state?.toLowerCase() === "open")

  console.log(`\nOpen Issues for ${repo}:`)
  if (openIssues.length === 0) {
    console.log("  None")
  } else {
    for (const issue of openIssues) {
      console.log(`  #${issue.number} ${issue.title}`)
    }
  }

  console.log(`\nOpen Pull Requests for ${repo}:`)
  if (openPrs.length === 0) {
    console.log("  None")
  } else {
    for (const pr of openPrs) {
      console.log(`  #${pr.number} ${pr.title}`)
    }
  }
}

export const issueCommand: Command = {
  name: "issue",
  description: "Interact with GitHub issues and store (guards against operating on closed issues)",
  usage: "swiz issue <subcommand> [options]",
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
    {
      flags: "cache-bust [--repo <slug>]",
      description:
        "Clear cached issue/PR/CI data. Defaults to current repo; omit --repo to clear all.",
    },
    {
      flags: "sync [<repo>]",
      description:
        "Manually sync upstream GitHub state (issues, PRs, CI, labels) into the local store. " +
        "Defaults to current repo.",
    },
    {
      flags: "list [<repo>]",
      description: "List all currently open issues and pull requests from the local store.",
    },
  ],
  async run(args: string[]) {
    const sub = args[0]
    if (sub === "cache-bust") return handleCacheBust(args)
    if (sub === "sync") return handleSync(args)
    if (sub === "list") return handleList(args)

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
