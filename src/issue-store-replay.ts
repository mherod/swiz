import { resolveSpawnCwd } from "./cwd.ts"
import { debugLog } from "./debug.ts"
import type { IssueStore, MutationPayload, PendingMutation } from "./issue-store.ts"
import { isGraphQLRateLimited, tryMutationRestFallback } from "./issue-store-rest-fallback.ts"
import { messageFromUnknownError } from "./utils/hook-json-helpers.ts"

// ─── Replay ─────────────────────────────────────────────────────────────────

/** Maximum attempts before a mutation is discarded. */
const MAX_ATTEMPTS = 5

export interface ReplayResult {
  replayed: number
  failed: number
  discarded: number
}

/**
 * Replay pending mutations for a repo against live GitHub.
 * Runs each queued mutation via `gh`, removes on success, bumps attempt count
 * on failure, and discards after MAX_ATTEMPTS.
 *
 * Call this opportunistically when a live GitHub connection is confirmed.
 */
export async function replayPendingMutations(
  repo: string,
  cwd: string,
  store?: IssueStore,
  concurrency = 5
): Promise<ReplayResult> {
  const { getIssueStore } = await import("./issue-store.ts")
  const s = store ?? getIssueStore()
  const pending = s.getPendingMutations(repo)
  const result: ReplayResult = { replayed: 0, failed: 0, discarded: 0 }

  if (pending.length === 0) return result

  // 1. Group by issue number to maintain per-issue ordering
  const mutationsByIssue = new Map<number, PendingMutation[]>()
  for (const row of pending) {
    const payload: MutationPayload = JSON.parse(row.mutation)
    const list = mutationsByIssue.get(payload.number) ?? []
    list.push(row)
    mutationsByIssue.set(payload.number, list)
  }

  // 2. Define per-issue worker task
  const issueTasks = Array.from(mutationsByIssue.values()).map((rows) => async () => {
    for (const row of rows) {
      const mutation: MutationPayload = JSON.parse(row.mutation)

      if (row.attempts >= MAX_ATTEMPTS) {
        s.removeMutation(row.id)
        result.discarded++
        debugLog(
          `[swiz] REPLAY_DISCARDED repo=${repo} issue=#${mutation.number} type=${mutation.type} attempts=${row.attempts}`
        )
        continue
      }

      const ok = await executeMutation(mutation, cwd, repo)

      if (ok) {
        s.removeMutation(row.id)
        invalidateLocalCache(s, repo, mutation)
        result.replayed++
      } else {
        s.markAttempted(row.id)
        result.failed++
        // Stop sequential execution for THIS issue on first failure to preserve order
        break
      }
    }
  })

  // 3. Run with concurrency limit
  await runWithLimit(concurrency, issueTasks)

  return result
}

/**
 * After a successful mutation, update the local cache to reflect the change.
 * Removes closed issues and merged PRs so local consumers see consistent state.
 */
function invalidateLocalCache(store: IssueStore, repo: string, mutation: MutationPayload): void {
  switch (mutation.type) {
    case "close":
    case "resolve":
      store.removeIssue(repo, mutation.number)
      break
    case "pr_merge":
      store.removePullRequest(repo, mutation.number)
      break
  }
}

/** Simple concurrency-limited promise pool. */
async function runWithLimit(concurrency: number, tasks: (() => Promise<void>)[]): Promise<void> {
  let nextTaskIndex = 0
  async function worker() {
    while (nextTaskIndex < tasks.length) {
      const task = tasks[nextTaskIndex++]
      if (task) await task()
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker)
  await Promise.all(workers)
}

/** Execute a single mutation against live GitHub via gh CLI. Returns true on success. */
async function executeCommentMutation(
  mutation: MutationPayload,
  num: string,
  cwd: string,
  repo: string
): Promise<boolean> {
  if (!mutation.body) return true
  return runGhCommand(["gh", "issue", "comment", num, "--body", mutation.body], cwd, repo, mutation)
}

async function executeLabelAddMutation(
  mutation: MutationPayload,
  num: string,
  cwd: string,
  repo: string
): Promise<boolean> {
  if (!mutation.labels?.length) return true
  return runGhCommand(
    ["gh", "issue", "edit", num, ...mutation.labels.flatMap((l) => ["--add-label", l])],
    cwd,
    repo,
    mutation
  )
}

async function executeMilestoneSetMutation(
  mutation: MutationPayload,
  num: string,
  cwd: string,
  repo: string
): Promise<boolean> {
  if (mutation.milestone == null) return true
  return runGhCommand(
    ["gh", "issue", "edit", num, "--milestone", String(mutation.milestone)],
    cwd,
    repo,
    mutation
  )
}

async function executeMutation(
  mutation: MutationPayload,
  cwd: string,
  repo: string
): Promise<boolean> {
  const num = String(mutation.number)
  switch (mutation.type) {
    case "close":
      return runGhCommand(["gh", "issue", "close", num], cwd, repo, mutation)
    case "comment":
      return executeCommentMutation(mutation, num, cwd, repo)
    case "resolve":
      return executeResolveMutation(mutation, num, cwd, repo)
    case "label_add":
      return executeLabelAddMutation(mutation, num, cwd, repo)
    case "milestone_set":
      return executeMilestoneSetMutation(mutation, num, cwd, repo)
    case "pr_comment":
    case "pr_merge":
    case "pr_review":
      return executePrMutation(mutation, num, cwd, repo)
    default:
      return false
  }
}

async function executeResolveMutation(
  mutation: MutationPayload,
  num: string,
  cwd: string,
  repo: string
): Promise<boolean> {
  if (mutation.body) {
    const ok = await runGhCommand(
      ["gh", "issue", "comment", num, "--body", mutation.body],
      cwd,
      repo,
      { ...mutation, type: "comment" }
    )
    if (!ok) return false
  }
  return runGhCommand(["gh", "issue", "close", num], cwd, repo, { ...mutation, type: "close" })
}

async function executePrMutation(
  mutation: MutationPayload,
  num: string,
  cwd: string,
  repo: string
): Promise<boolean> {
  switch (mutation.type) {
    case "pr_comment":
      if (!mutation.body) return true
      return runGhCommand(
        ["gh", "pr", "comment", num, "--body", mutation.body],
        cwd,
        repo,
        mutation
      )
    case "pr_merge":
      return runGhCommand(["gh", "pr", "merge", num, "--squash"], cwd, repo, mutation)
    case "pr_review": {
      const event = mutation.reviewEvent ?? "COMMENT"
      const args = ["gh", "pr", "review", num, `--${event.toLowerCase().replace("_", "-")}`]
      if (mutation.body) args.push("--body", mutation.body)
      return runGhCommand(args, cwd, repo, mutation)
    }
    default:
      return false
  }
}

async function runGhCommand(
  args: string[],
  cwd: string,
  repo: string,
  mutationForLog: MutationPayload
): Promise<boolean> {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  if (proc.exitCode === 0) return true

  // REST API fallback on GraphQL rate-limit for mutation types with REST equivalents
  if (isGraphQLRateLimited(stderr)) {
    const restResult = await tryMutationRestFallback(mutationForLog, cwd, repo)
    if (restResult) return true
  }

  logReplayExecFailed(repo, mutationForLog, proc.exitCode ?? 1, stderr)
  return false
}

/** Log a structured execution failure for a single mutation replay. */
function logReplayExecFailed(
  repo: string,
  mutation: MutationPayload,
  exitCode: number,
  stderr: string
): void {
  const detail = stderr.trim().slice(0, 200)
  debugLog(
    `[swiz] REPLAY_EXEC_FAILED repo=${repo} issue=#${mutation.number} type=${mutation.type} exit=${exitCode}${detail ? ` detail=${detail}` : ""}`
  )
}

// ─── Replay entrypoint used by CLI / dispatch ──────────────────────────────

/**
 * Best-effort replay: resolve repo slug from cwd and drain pending mutations.
 * Catches all errors — never throws. Safe to call from any entry point.
 * Logs outcomes to stderr so failures are visible without blocking execution.
 */
export async function tryReplayPendingMutations(cwd?: string): Promise<void> {
  try {
    const dir = resolveSpawnCwd(cwd)
    const { getRepoSlug, isGitRepo, hasGhCli } = await import("./git-helpers.ts")
    if (!hasGhCli()) return
    if (!(await isGitRepo(dir))) return
    const slug = await getRepoSlug(dir)
    if (!slug) return

    const { getIssueStore } = await import("./issue-store.ts")
    const store = getIssueStore()
    const pending = store.pendingCount(slug)
    if (pending === 0) return

    const result = await replayPendingMutations(slug, dir, store)
    logReplayResult(result, pending, slug)
  } catch (err) {
    debugLog(`[swiz] REPLAY_INFRA_ERROR ${messageFromUnknownError(err)}`)
  }
}

/** Log the outcome of a replay attempt to stderr with structured error code. */
function logReplayResult(result: ReplayResult, originalCount: number, repo: string): void {
  const parts: string[] = []
  if (result.replayed > 0) parts.push(`${result.replayed} replayed`)
  if (result.failed > 0) parts.push(`${result.failed} failed`)
  if (result.discarded > 0) parts.push(`${result.discarded} discarded`)
  if (parts.length === 0) return
  debugLog(`[swiz] REPLAY_SUMMARY repo=${repo} pending=${originalCount} ${parts.join(", ")}`)
}
