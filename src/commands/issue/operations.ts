import { debugLog } from "../../debug.ts"
import { acquireGhSlot, observeGhApiIncludeOutput } from "../../gh-rate-limit.ts"
import { getRepoSlug, issueState } from "../../git-helpers.ts"
import { getIssueStore, isGraphQLRateLimited } from "../../issue-store.ts"
import { syncUpstreamState } from "../../issue-store-sync.ts"

const ONE_HOUR_MS = 60 * 60 * 1000

interface GhCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface IssueOperationDependencies {
  cwd?: string
  getRepoSlug?: typeof getRepoSlug
  issueState?: typeof issueState
  acquireGhSlot?: typeof acquireGhSlot
  runGh?: (args: string[], cwd: string) => Promise<GhCommandResult>
}

async function runGhCommand(args: string[], cwd: string): Promise<GhCommandResult> {
  const proc = Bun.spawn(["gh", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { exitCode: proc.exitCode ?? 1, stdout, stderr }
}

function resolveDependencies(overrides: IssueOperationDependencies = {}) {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    getRepoSlug: overrides.getRepoSlug ?? getRepoSlug,
    issueState: overrides.issueState ?? issueState,
    acquireGhSlot: overrides.acquireGhSlot ?? acquireGhSlot,
    runGh: overrides.runGh ?? runGhCommand,
  }
}

/** Sync upstream state if the local store hasn't been refreshed in the last hour. */
export async function ensureFreshData(repo: string, cwd: string): Promise<void> {
  const store = getIssueStore()
  const fresh = store.listIssues(repo, ONE_HOUR_MS)
  if (fresh.length > 0) return
  console.log(`🔄 Data stale (>1h) — syncing ${repo}...`)
  await syncUpstreamState(repo, cwd)
}

/** Close an issue via REST API fallback when GraphQL is rate-limited. */
async function closeIssueViaRest(
  slug: string,
  number: string,
  cwd: string,
  runGh: (args: string[], cwd: string) => Promise<GhCommandResult>
): Promise<boolean> {
  debugLog(`[swiz] REST_FALLBACK closing issue #${number} on ${slug}`)
  const result = await runGh(
    ["api", "--include", `repos/${slug}/issues/${number}`, "-X", "PATCH", "-f", "state=closed"],
    cwd
  )
  if (result.stdout.trim()) observeGhApiIncludeOutput(result.stdout)
  return result.exitCode === 0
}

/** Comment on an issue via REST API fallback when GraphQL is rate-limited. */
async function commentViaRest(
  slug: string,
  number: string,
  body: string,
  cwd: string,
  runGh: (args: string[], cwd: string) => Promise<GhCommandResult>
): Promise<boolean> {
  debugLog(`[swiz] REST_FALLBACK commenting on issue #${number} on ${slug}`)
  const result = await runGh(
    ["api", "--include", `repos/${slug}/issues/${number}/comments`, "-f", `body=${body}`],
    cwd
  )
  if (result.stdout.trim()) observeGhApiIncludeOutput(result.stdout)
  return result.exitCode === 0
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
  cwd: string,
  runGh: (args: string[], cwd: string) => Promise<GhCommandResult>
): Promise<void> {
  if (isGraphQLRateLimited(stderr) && slug) {
    if (await closeIssueViaRest(slug, number, cwd, runGh)) {
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

export async function closeIssue(
  number: string,
  overrides: IssueOperationDependencies = {}
): Promise<void> {
  const dependencies = resolveDependencies(overrides)
  const { cwd } = dependencies
  const slug = await dependencies.getRepoSlug(cwd)
  if (slug) await ensureFreshData(slug, cwd)
  const state = await dependencies.issueState(number, cwd)
  if (state !== "OPEN") {
    console.log(`  Issue #${number} is already ${state ?? "unknown"} — skipping close.`)
    return
  }

  await dependencies.acquireGhSlot()
  const result = await dependencies.runGh(["issue", "close", number], cwd)

  if (result.exitCode !== 0) {
    await handleCloseFailure(slug, number, result.stderr, result.exitCode, cwd, dependencies.runGh)
    return
  }
  removeFromStore(slug, number)
}

export async function commentOnIssue(
  number: string,
  body: string,
  overrides: IssueOperationDependencies = {}
): Promise<void> {
  const dependencies = resolveDependencies(overrides)
  const { cwd } = dependencies
  const slug = await dependencies.getRepoSlug(cwd)
  if (slug) await ensureFreshData(slug, cwd)
  const state = await dependencies.issueState(number, cwd)

  if (state !== "OPEN") {
    console.log(`  Issue #${number} is already ${state ?? "unknown"} — skipping comment.`)
    return
  }

  await dependencies.acquireGhSlot()
  const result = await dependencies.runGh(["issue", "comment", number, "--body", body], cwd)

  if (result.exitCode !== 0) {
    if (isGraphQLRateLimited(result.stderr) && slug) {
      if (await commentViaRest(slug, number, body, cwd, dependencies.runGh)) return
    }

    if (slug) {
      try {
        getIssueStore().queueMutation(slug, { type: "comment", number: parseInt(number, 10), body })
      } catch {}
    }
    throw new Error(`gh issue comment failed with exit code ${result.exitCode}`)
  }
}

export interface ResolveResult {
  issueNumber: string
  finalState: "OPEN" | "CLOSED" | null
  alreadyClosed: boolean
  commentPosted: boolean
  closedNow: boolean
}

async function postComment(
  number: string,
  body: string,
  cwd: string,
  slug: string | null,
  dependencies: ReturnType<typeof resolveDependencies>
): Promise<void> {
  await dependencies.acquireGhSlot()
  const result = await dependencies.runGh(["issue", "comment", number, "--body", body], cwd)
  if (result.exitCode === 0) return

  if (isGraphQLRateLimited(result.stderr) && slug) {
    if (await commentViaRest(slug, number, body, cwd, dependencies.runGh)) return
  }

  if (slug) {
    try {
      getIssueStore().queueMutation(slug, { type: "comment", number: parseInt(number, 10), body })
    } catch {}
  }
  throw new Error(`gh issue comment failed with exit code ${result.exitCode}`)
}

async function closeAndRemove(
  number: string,
  cwd: string,
  slug: string | null,
  dependencies: ReturnType<typeof resolveDependencies>
): Promise<void> {
  await dependencies.acquireGhSlot()
  const result = await dependencies.runGh(["issue", "close", number], cwd)

  if (result.exitCode !== 0) {
    if (isGraphQLRateLimited(result.stderr) && slug) {
      if (await closeIssueViaRest(slug, number, cwd, dependencies.runGh)) {
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
    throw new Error(`gh issue close failed with exit code ${result.exitCode}`)
  }
  if (slug) {
    try {
      getIssueStore().removeIssue(slug, parseInt(number, 10))
    } catch {}
  }
}

export async function resolveIssue(
  number: string,
  body?: string,
  overrides: IssueOperationDependencies = {}
): Promise<ResolveResult> {
  const dependencies = resolveDependencies(overrides)
  const { cwd } = dependencies
  const slug = await dependencies.getRepoSlug(cwd)
  if (slug) await ensureFreshData(slug, cwd)
  const state = await dependencies.issueState(number, cwd)
  const alreadyClosed = state !== "OPEN"

  let commentPosted = false
  if (body) {
    await postComment(number, body, cwd, slug, dependencies)
    commentPosted = true
  }

  let closedNow = false
  if (!alreadyClosed) {
    await closeAndRemove(number, cwd, slug, dependencies)
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
