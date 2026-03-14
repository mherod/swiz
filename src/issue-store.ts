/**
 * Local SQLite-backed repo-scoped sync store with GitHub sync fallback.
 * Uses Bun's built-in SQLite support — no external dependencies.
 *
 * Tables:
 * - `issues`: TTL-cached issue read store (refreshed on successful gh calls)
 * - `pull_requests`: TTL-cached PR read store
 * - `ci_status`: TTL-cached CI run status per commit SHA
 * - `pending_mutations`: Queued outbound mutations for offline replay
 */

import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

import { resolveCwd } from "./cwd.ts"
import { debugLog } from "./debug.ts"
import { getHomeDirWithFallback } from "./home.ts"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CachedIssue {
  repo: string
  number: number
  data: string // JSON blob matching gh issue list output
  synced_at: number
}

export interface PendingMutation {
  id: number
  repo: string
  mutation: string // JSON: {type:"close"|"comment"|"resolve", number, body?}
  created_at: number
  last_attempt: number | null
  attempts: number
}

export interface CachedPullRequest {
  repo: string
  number: number
  data: string // JSON blob matching gh pr list output
  synced_at: number
}

export interface CachedCiStatus {
  repo: string
  sha: string
  data: string // JSON blob: {status, conclusion, run_id, url, jobs}
  synced_at: number
}

export type MutationType = "close" | "comment" | "resolve" | "pr_comment" | "pr_merge" | "pr_review"

export interface MutationPayload {
  type: MutationType
  number: number
  body?: string
  /** For pr_review: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" */
  reviewEvent?: string
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default TTL for cached issues: 5 minutes (max GitHub cache TTL rule — no GitHub cache may exceed 300_000 ms) */
export const DEFAULT_TTL_MS = 5 * 60 * 1000

// ─── Store ──────────────────────────────────────────────────────────────────

export class IssueStore {
  private db: Database

  constructor(dbPath?: string) {
    const path = dbPath ?? getDefaultDbPath()
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.run("PRAGMA journal_mode=WAL")
    this.migrate()
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS issues (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        data TEXT NOT NULL,
        synced_at INTEGER NOT NULL,
        PRIMARY KEY (repo, number)
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS pull_requests (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        data TEXT NOT NULL,
        synced_at INTEGER NOT NULL,
        PRIMARY KEY (repo, number)
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS ci_status (
        repo TEXT NOT NULL,
        sha TEXT NOT NULL,
        data TEXT NOT NULL,
        synced_at INTEGER NOT NULL,
        PRIMARY KEY (repo, sha)
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS pending_mutations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        mutation TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_attempt INTEGER,
        attempts INTEGER DEFAULT 0
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS ci_branch_runs (
        repo TEXT NOT NULL,
        branch TEXT NOT NULL,
        data TEXT NOT NULL,
        synced_at INTEGER NOT NULL,
        PRIMARY KEY (repo, branch)
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS pr_branch_detail (
        repo TEXT NOT NULL,
        branch TEXT NOT NULL,
        data TEXT NOT NULL,
        synced_at INTEGER NOT NULL,
        PRIMARY KEY (repo, branch)
      )
    `)
  }

  // ─── Read operations ────────────────────────────────────────────────────

  /** List cached issues for a repo. Returns only issues within TTL window. */
  listIssues<T = unknown>(repo: string, ttlMs = DEFAULT_TTL_MS): T[] {
    const cutoff = Date.now() - ttlMs
    const rows = this.db
      .query("SELECT data FROM issues WHERE repo = ? AND synced_at > ?")
      .all(repo, cutoff) as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as T)
  }

  /** Get a single cached issue by repo and number. */
  getIssue<T = unknown>(repo: string, number: number): T | null {
    const row = this.db
      .query("SELECT data FROM issues WHERE repo = ? AND number = ?")
      .get(repo, number) as { data: string } | null
    return row ? (JSON.parse(row.data) as T) : null
  }

  // ─── Write operations ───────────────────────────────────────────────────

  /** Upsert issues from a successful gh call. Replaces existing data. */
  upsertIssues<T extends { number: number }>(repo: string, issues: T[]): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO issues (repo, number, data, synced_at) VALUES (?, ?, ?, ?)"
    )
    const now = Date.now()
    const tx = this.db.transaction(() => {
      for (const issue of issues) {
        stmt.run(repo, issue.number, JSON.stringify(issue), now)
      }
    })
    tx()
  }

  /** Remove a cached issue (e.g., after closing). */
  removeIssue(repo: string, number: number): void {
    this.db.query("DELETE FROM issues WHERE repo = ? AND number = ?").run(repo, number)
  }

  // ─── Pull request operations ──────────────────────────────────────────

  /** List cached PRs for a repo. Returns only PRs within TTL window. */
  listPullRequests<T = unknown>(repo: string, ttlMs = DEFAULT_TTL_MS): T[] {
    const cutoff = Date.now() - ttlMs
    const rows = this.db
      .query("SELECT data FROM pull_requests WHERE repo = ? AND synced_at > ?")
      .all(repo, cutoff) as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as T)
  }

  /** Get a single cached PR by repo and number. */
  getPullRequest<T = unknown>(repo: string, number: number): T | null {
    const row = this.db
      .query("SELECT data FROM pull_requests WHERE repo = ? AND number = ?")
      .get(repo, number) as { data: string } | null
    return row ? (JSON.parse(row.data) as T) : null
  }

  /** Upsert PRs from a successful gh call. Replaces existing data. */
  upsertPullRequests<T extends { number: number }>(repo: string, prs: T[]): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO pull_requests (repo, number, data, synced_at) VALUES (?, ?, ?, ?)"
    )
    const now = Date.now()
    const tx = this.db.transaction(() => {
      for (const pr of prs) {
        stmt.run(repo, pr.number, JSON.stringify(pr), now)
      }
    })
    tx()
  }

  /** Remove a cached PR (e.g., after merging). */
  removePullRequest(repo: string, number: number): void {
    this.db.query("DELETE FROM pull_requests WHERE repo = ? AND number = ?").run(repo, number)
  }

  // ─── CI status operations ─────────────────────────────────────────────

  /** List cached CI statuses for a repo. Returns only entries within TTL window. */
  listCiStatuses<T = unknown>(repo: string, ttlMs = DEFAULT_TTL_MS): T[] {
    const cutoff = Date.now() - ttlMs
    const rows = this.db
      .query("SELECT data FROM ci_status WHERE repo = ? AND synced_at > ?")
      .all(repo, cutoff) as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as T)
  }

  /** Get CI status for a specific commit SHA. */
  getCiStatus<T = unknown>(repo: string, sha: string): T | null {
    const row = this.db
      .query("SELECT data FROM ci_status WHERE repo = ? AND sha = ?")
      .get(repo, sha) as { data: string } | null
    return row ? (JSON.parse(row.data) as T) : null
  }

  /** Upsert CI status records. Each record must have a `sha` field. */
  upsertCiStatuses<T extends { sha: string }>(repo: string, statuses: T[]): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO ci_status (repo, sha, data, synced_at) VALUES (?, ?, ?, ?)"
    )
    const now = Date.now()
    const tx = this.db.transaction(() => {
      for (const status of statuses) {
        stmt.run(repo, status.sha, JSON.stringify(status), now)
      }
    })
    tx()
  }

  /** Remove a CI status entry. */
  removeCiStatus(repo: string, sha: string): void {
    this.db.query("DELETE FROM ci_status WHERE repo = ? AND sha = ?").run(repo, sha)
  }

  // ─── CI branch runs ──────────────────────────────────────────────────

  /** Get cached CI runs for a specific branch. Returns null if no fresh data. */
  getCiBranchRuns<T = unknown>(repo: string, branch: string, ttlMs = DEFAULT_TTL_MS): T[] | null {
    const cutoff = Date.now() - ttlMs
    const row = this.db
      .query("SELECT data FROM ci_branch_runs WHERE repo = ? AND branch = ? AND synced_at > ?")
      .get(repo, branch, cutoff) as { data: string } | null
    if (!row) return null
    return JSON.parse(row.data) as T[]
  }

  /** Upsert CI runs for a branch. Stores the full array as a JSON blob. */
  upsertCiBranchRuns<T>(repo: string, branch: string, runs: T[]): void {
    this.db
      .query(
        "INSERT OR REPLACE INTO ci_branch_runs (repo, branch, data, synced_at) VALUES (?, ?, ?, ?)"
      )
      .run(repo, branch, JSON.stringify(runs), Date.now())
  }

  // ─── PR branch detail ──────────────────────────────────────────────────

  /** Get cached PR detail for a specific branch. Returns null if no fresh data. */
  getPrBranchDetail<T = unknown>(repo: string, branch: string, ttlMs = DEFAULT_TTL_MS): T | null {
    const cutoff = Date.now() - ttlMs
    const row = this.db
      .query("SELECT data FROM pr_branch_detail WHERE repo = ? AND branch = ? AND synced_at > ?")
      .get(repo, branch, cutoff) as { data: string } | null
    if (!row) return null
    return JSON.parse(row.data) as T
  }

  /** Upsert PR detail for a branch (reviewDecision, commentCount, etc.). */
  upsertPrBranchDetail<T>(repo: string, branch: string, detail: T): void {
    this.db
      .query(
        "INSERT OR REPLACE INTO pr_branch_detail (repo, branch, data, synced_at) VALUES (?, ?, ?, ?)"
      )
      .run(repo, branch, JSON.stringify(detail), Date.now())
  }

  // ─── Mutation queue ─────────────────────────────────────────────────────

  /** Queue a mutation for later replay when GitHub is unavailable. */
  queueMutation(repo: string, mutation: MutationPayload): void {
    this.db
      .query("INSERT INTO pending_mutations (repo, mutation, created_at) VALUES (?, ?, ?)")
      .run(repo, JSON.stringify(mutation), Date.now())
  }

  /** Get all pending mutations for a repo, ordered by creation time. */
  getPendingMutations(repo: string): PendingMutation[] {
    return this.db
      .query("SELECT * FROM pending_mutations WHERE repo = ? ORDER BY created_at")
      .all(repo) as PendingMutation[]
  }

  /** Mark a mutation as attempted (bump attempt count and timestamp). */
  markAttempted(id: number): void {
    this.db
      .query("UPDATE pending_mutations SET attempts = attempts + 1, last_attempt = ? WHERE id = ?")
      .run(Date.now(), id)
  }

  /** Remove a successfully replayed mutation. */
  removeMutation(id: number): void {
    this.db.query("DELETE FROM pending_mutations WHERE id = ?").run(id)
  }

  /** Count pending mutations for a repo. */
  pendingCount(repo: string): number {
    const row = this.db
      .query("SELECT COUNT(*) as cnt FROM pending_mutations WHERE repo = ?")
      .get(repo) as { cnt: number }
    return row.cnt
  }

  // ─── Cache management ───────────────────────────────────────────────────

  /** Clear all cached data (issues, PRs, CI) for a repo. Preserves pending mutations. */
  clearCachedData(repo: string): void {
    this.db.query("DELETE FROM issues WHERE repo = ?").run(repo)
    this.db.query("DELETE FROM pull_requests WHERE repo = ?").run(repo)
    this.db.query("DELETE FROM ci_status WHERE repo = ?").run(repo)
    this.db.query("DELETE FROM ci_branch_runs WHERE repo = ?").run(repo)
    this.db.query("DELETE FROM pr_branch_detail WHERE repo = ?").run(repo)
  }

  /** Clear ALL cached data across all repos. Preserves pending mutations. */
  clearAllCachedData(): void {
    this.db.query("DELETE FROM issues").run()
    this.db.query("DELETE FROM pull_requests").run()
    this.db.query("DELETE FROM ci_status").run()
    this.db.query("DELETE FROM ci_branch_runs").run()
    this.db.query("DELETE FROM pr_branch_detail").run()
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  close(): void {
    this.db.close()
  }
}

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
      if (!mutation.body) return true
      return runGhCommand(
        ["gh", "issue", "comment", num, "--body", mutation.body],
        cwd,
        repo,
        mutation
      )
    case "resolve":
      return executeResolveMutation(mutation, num, cwd, repo)
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

/**
 * Best-effort replay: resolve repo slug from cwd and drain pending mutations.
 * Catches all errors — never throws. Safe to call from any entry point.
 * Logs outcomes to stderr so failures are visible without blocking execution.
 */
export async function tryReplayPendingMutations(cwd?: string): Promise<void> {
  try {
    const dir = resolveCwd(cwd)
    const { getRepoSlug, isGitRepo, hasGhCli } = await import("./git-helpers.ts")
    if (!hasGhCli()) return
    if (!(await isGitRepo(dir))) return
    const slug = await getRepoSlug(dir)
    if (!slug) return
    const store = getIssueStore()
    const pending = store.pendingCount(slug)
    if (pending === 0) return
    const result = await replayPendingMutations(slug, dir, store)
    logReplayResult(result, pending, slug)
  } catch (err) {
    debugLog(`[swiz] REPLAY_INFRA_ERROR ${err instanceof Error ? err.message : String(err)}`)
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

// ─── Upstream sync ──────────────────────────────────────────────────────────

export interface UpstreamSyncResult {
  issues: { upserted: number }
  pullRequests: { upserted: number }
  ciStatuses: { upserted: number }
}

/**
 * Poll upstream GitHub state for a repo and refresh the local store.
 * Fetches open issues, open PRs, and recent workflow runs, then upserts
 * into the shared store. Safe to call on a cadence from the daemon.
 */
export async function syncUpstreamState(
  repo: string,
  cwd: string,
  store?: IssueStore
): Promise<UpstreamSyncResult> {
  const s = store ?? getIssueStore()
  const result: UpstreamSyncResult = {
    issues: { upserted: 0 },
    pullRequests: { upserted: 0 },
    ciStatuses: { upserted: 0 },
  }

  const [issues, prs, runs] = await Promise.all([
    fetchGhJson<{ number: number }[]>(
      [
        "issue",
        "list",
        "--state",
        "open",
        "--json",
        "number,title,state,labels,author,assignees,updatedAt",
        "--limit",
        "100",
      ],
      cwd
    ),
    fetchGhJson<{ number: number }[]>(
      [
        "pr",
        "list",
        "--state",
        "open",
        "--json",
        "number,title,state,headRefName,author,reviewDecision,statusCheckRollup,mergeable,url,createdAt,updatedAt",
        "--limit",
        "100",
      ],
      cwd
    ),
    fetchGhJson<
      { headSha: string; databaseId: number; status: string; conclusion: string; url: string }[]
    >(["run", "list", "--json", "headSha,databaseId,status,conclusion,url", "--limit", "20"], cwd),
  ])

  if (issues && issues.length > 0) {
    s.upsertIssues(repo, issues)
    result.issues.upserted = issues.length
  }

  if (prs && prs.length > 0) {
    s.upsertPullRequests(repo, prs)
    result.pullRequests.upserted = prs.length
  }

  if (runs && runs.length > 0) {
    const ciRecords = runs.map((r) => ({
      sha: r.headSha,
      run_id: r.databaseId,
      status: r.status,
      conclusion: r.conclusion,
      url: r.url,
    }))
    s.upsertCiStatuses(repo, ciRecords)
    result.ciStatuses.upserted = ciRecords.length
  }

  return result
}

/** Detect GraphQL rate-limit errors in gh CLI stderr output. */
function isGraphQLRateLimited(stderr: string): boolean {
  return stderr.includes("API rate limit") && stderr.includes("GraphQL")
}

interface RestFallbackMapping {
  endpoint: string
  /** Transforms the raw REST response body into the shape expected by the caller. */
  normalize?: (raw: unknown) => unknown
}

/**
 * Lookup table mapping `gh <entity> list` commands to REST API fallbacks.
 * The `normalize` function adapts REST response shapes to match gh CLI output shapes.
 */
const REST_FALLBACK_MAP: Record<string, RestFallbackMapping> = {
  "issue:list": { endpoint: "repos/{owner}/{repo}/issues?state=open&per_page=100" },
  "pr:list": { endpoint: "repos/{owner}/{repo}/pulls?state=open&per_page=100" },
  "run:list": {
    endpoint: "repos/{owner}/{repo}/actions/runs?per_page=20",
    normalize: (raw) => {
      const data = raw as {
        workflow_runs?: Array<{
          head_sha: string
          id: number
          status: string
          conclusion: string | null
          html_url: string
        }>
      }
      return (data.workflow_runs ?? []).map((r) => ({
        headSha: r.head_sha,
        databaseId: r.id,
        status: r.status,
        conclusion: r.conclusion ?? "",
        url: r.html_url,
      }))
    },
  },
  "release:list": {
    endpoint: "repos/{owner}/{repo}/releases?per_page=30",
    normalize: (raw) => {
      const releases = raw as Array<{
        tag_name: string
        name: string
        draft: boolean
        prerelease: boolean
        published_at: string | null
        created_at: string
      }>
      return releases.map((r) => ({
        tagName: r.tag_name,
        name: r.name,
        isDraft: r.draft,
        isPrerelease: r.prerelease,
        publishedAt: r.published_at ?? r.created_at,
        createdAt: r.created_at,
      }))
    },
  },
  "label:list": { endpoint: "repos/{owner}/{repo}/labels?per_page=100" },
  "milestone:list": {
    endpoint: "repos/{owner}/{repo}/milestones?state=open&per_page=100",
    normalize: (raw) => {
      const milestones = raw as Array<{
        number: number
        title: string
        description: string | null
        state: string
        due_on: string | null
        open_issues: number
        closed_issues: number
      }>
      return milestones.map((m) => ({
        number: m.number,
        title: m.title,
        description: m.description ?? "",
        state: m.state,
        dueOn: m.due_on,
        openIssues: m.open_issues,
        closedIssues: m.closed_issues,
      }))
    },
  },
  "repo:list": {
    endpoint: "user/repos?per_page=100",
    normalize: (raw) => {
      const repos = raw as Array<{
        name: string
        full_name: string
        description: string | null
        private: boolean
        html_url: string
      }>
      return repos.map((r) => ({
        name: r.name,
        nameWithOwner: r.full_name,
        description: r.description ?? "",
        isPrivate: r.private,
        url: r.html_url,
      }))
    },
  },
  "workflow:list": {
    endpoint: "repos/{owner}/{repo}/actions/workflows?per_page=100",
    normalize: (raw) => {
      const data = raw as {
        workflows?: Array<{
          id: number
          name: string
          path: string
          state: string
        }>
      }
      return (data.workflows ?? []).map((w) => ({
        id: w.id,
        name: w.name,
        path: w.path,
        state: w.state,
      }))
    },
  },
  "secret:list": {
    endpoint: "repos/{owner}/{repo}/actions/secrets?per_page=100",
    normalize: (raw) => {
      const data = raw as {
        secrets?: Array<{
          name: string
          created_at: string
          updated_at: string
        }>
      }
      return (data.secrets ?? []).map((s) => ({
        name: s.name,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
      }))
    },
  },
  "variable:list": {
    endpoint: "repos/{owner}/{repo}/actions/variables?per_page=100",
    normalize: (raw) => {
      const data = raw as {
        variables?: Array<{
          name: string
          value: string
          created_at: string
          updated_at: string
        }>
      }
      return (data.variables ?? []).map((v) => ({
        name: v.name,
        value: v.value,
        createdAt: v.created_at,
        updatedAt: v.updated_at,
      }))
    },
  },
  "environment:list": {
    endpoint: "repos/{owner}/{repo}/environments?per_page=100",
    normalize: (raw) => {
      const data = raw as {
        environments?: Array<{
          id: number
          name: string
          created_at: string
          updated_at: string
        }>
      }
      return (data.environments ?? []).map((e) => ({
        id: e.id,
        name: e.name,
        createdAt: e.created_at,
        updatedAt: e.updated_at,
      }))
    },
  },
}

/**
 * Map a `gh <entity> list` command to its REST API fallback.
 * Returns null if the command has no REST equivalent.
 *
 * Exported for unit testing.
 */
export function ghListToRestFallback(args: string[]): RestFallbackMapping | null {
  return REST_FALLBACK_MAP[`${args[0]}:${args[1]}`] ?? null
}

/** Fetch via REST API as fallback when GraphQL is rate-limited. */
async function fetchViaRest(endpoint: string, cwd: string): Promise<unknown> {
  const proc = Bun.spawn(["gh", "api", endpoint], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  if (proc.exitCode !== 0) return null
  try {
    return JSON.parse(stdout)
  } catch {
    return null
  }
}

/**
 * Attempt REST API fallback for a gh list command.
 * Returns null if no REST mapping exists for the command or if REST also fails.
 * Logs a descriptive message when no mapping is registered so the gap is observable.
 *
 * Exported for unit testing.
 */
export async function tryRestFallback<T>(args: string[], cwd: string): Promise<T | null> {
  const mapping = ghListToRestFallback(args)
  if (!mapping) {
    debugLog(`[swiz] NO_REST_FALLBACK for ${args.join(" ")} — no REST endpoint mapping registered`)
    return null
  }
  debugLog(`[swiz] REST_FALLBACK for ${args.join(" ")}`)
  const raw = await fetchViaRest(mapping.endpoint, cwd)
  if (raw === null) return null
  return (mapping.normalize ? mapping.normalize(raw) : raw) as T
}

/** Run a gh subcommand and parse JSON output. Returns null on failure.
 *  Automatically retries via REST API when the command fails or returns empty results. */
async function fetchGhJson<T>(args: string[], cwd: string): Promise<T | null> {
  const proc = Bun.spawn(["gh", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  if (proc.exitCode !== 0) {
    debugLog(
      isGraphQLRateLimited(stderr)
        ? `[swiz] GRAPHQL_RATE_LIMITED for ${args.join(" ")}`
        : `[swiz] GH_FETCH_FAILED exit=${proc.exitCode} for ${args.join(" ")}`
    )
    return tryRestFallback<T>(args, cwd)
  }
  let parsed: T | null = null
  try {
    parsed = JSON.parse(stdout) as T
  } catch {
    return null
  }
  // Also fall back to REST when gh succeeds but returns an empty list — the REST
  // endpoint may have fresher or less-filtered data (e.g. after a cache flush or
  // when a GraphQL query silently drops items due to scope mismatches).
  if (Array.isArray(parsed) && parsed.length === 0) {
    const restResult = await tryRestFallback<T>(args, cwd)
    if (restResult !== null && Array.isArray(restResult) && restResult.length > 0) {
      debugLog(`[swiz] REST_FALLBACK_NONEMPTY for ${args.join(" ")}`)
      return restResult
    }
  }
  return parsed
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getDefaultDbPath(): string {
  const home = getHomeDirWithFallback("/tmp")
  return join(home, ".swiz", "issues.db")
}

/** Return the path to the shared IssueStore database file. */
export function getIssueStoreDbPath(): string {
  return getDefaultDbPath()
}

/** Get or create a shared IssueStore instance. */
let sharedStore: IssueStore | null = null

export function getIssueStore(dbPath?: string): IssueStore {
  if (!sharedStore) {
    sharedStore = new IssueStore(dbPath)
  }
  return sharedStore
}

/** Reset the shared store (for testing). */
export function resetIssueStore(): void {
  sharedStore?.close()
  sharedStore = null
}
