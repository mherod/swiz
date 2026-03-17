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

import { Database, type Statement } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

import { resolveCwd } from "./cwd.ts"
import { debugLog } from "./debug.ts"
import { acquireGhSlot } from "./gh-rate-limit.ts"
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

export type MutationType =
  | "close"
  | "comment"
  | "resolve"
  | "pr_comment"
  | "pr_merge"
  | "pr_review"
  | "label_add"
  | "milestone_set"
  | "create"

export interface MutationPayload {
  type: MutationType
  number: number
  body?: string
  /** For pr_review: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" */
  reviewEvent?: string
  /** For label_add: label names to add */
  labels?: string[]
  /** For milestone_set: milestone number */
  milestone?: number
  /** For create: issue title */
  title?: string
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default TTL for cached issues: 5 minutes (max GitHub cache TTL rule — no GitHub cache may exceed 300_000 ms) */
export const DEFAULT_TTL_MS = 5 * 60 * 1000

// ─── Store ──────────────────────────────────────────────────────────────────

export class IssueStore {
  private db: Database
  private _stmtListIssues!: Statement<{ data: string }>
  private _stmtGetIssue!: Statement<{ data: string }>
  private _stmtRemoveIssue!: Statement
  private _stmtListPullRequests!: Statement<{ data: string }>
  private _stmtGetPullRequest!: Statement<{ data: string }>
  private _stmtRemovePullRequest!: Statement

  constructor(dbPath?: string) {
    const path = dbPath ?? getDefaultDbPath()
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.run("PRAGMA journal_mode=WAL")
    this.migrate()
    this._stmtListIssues = this.db.prepare(
      "SELECT data FROM issues WHERE repo = ? AND synced_at > ?"
    )
    this._stmtGetIssue = this.db.prepare("SELECT data FROM issues WHERE repo = ? AND number = ?")
    this._stmtRemoveIssue = this.db.prepare("DELETE FROM issues WHERE repo = ? AND number = ?")
    this._stmtListPullRequests = this.db.prepare(
      "SELECT data FROM pull_requests WHERE repo = ? AND synced_at > ?"
    )
    this._stmtGetPullRequest = this.db.prepare(
      "SELECT data FROM pull_requests WHERE repo = ? AND number = ?"
    )
    this._stmtRemovePullRequest = this.db.prepare(
      "DELETE FROM pull_requests WHERE repo = ? AND number = ?"
    )
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
    if (ttlMs <= 0) return [] // short-circuit: caller wants fresh data, skip query
    const rows = this._stmtListIssues.all(repo, Date.now() - ttlMs)
    return rows.map((r) => JSON.parse(r.data) as T)
  }

  /** Get a single cached issue by repo and number. */
  getIssue<T = unknown>(repo: string, number: number): T | null {
    const row = this._stmtGetIssue.get(repo, number)
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
    this._stmtRemoveIssue.run(repo, number)
  }

  /** Remove multiple cached issues in a single batch DELETE. */
  removeIssues(repo: string, numbers: number[]): void {
    if (numbers.length === 0) return
    const placeholders = numbers.map(() => "?").join(",")
    this.db
      .query(`DELETE FROM issues WHERE repo = ? AND number IN (${placeholders})`)
      .run(repo, ...numbers)
  }

  /** Remove cached issues whose numbers are not in the given set (i.e., closed upstream). */
  removeClosedIssues(repo: string, openNumbers: Set<number>): number {
    if (openNumbers.size === 0) {
      const result = this.db.query("DELETE FROM issues WHERE repo = ?").run(repo)
      return result.changes
    }
    const placeholders = [...openNumbers].map(() => "?").join(",")
    const result = this.db
      .query(`DELETE FROM issues WHERE repo = ? AND number NOT IN (${placeholders})`)
      .run(repo, ...openNumbers)
    return result.changes
  }

  // ─── Pull request operations ──────────────────────────────────────────

  /** List cached PRs for a repo. Returns only PRs within TTL window. */
  listPullRequests<T = unknown>(repo: string, ttlMs = DEFAULT_TTL_MS): T[] {
    const rows = this._stmtListPullRequests.all(repo, Date.now() - ttlMs)
    return rows.map((r) => JSON.parse(r.data) as T)
  }

  /** Get a single cached PR by repo and number. */
  getPullRequest<T = unknown>(repo: string, number: number): T | null {
    const row = this._stmtGetPullRequest.get(repo, number)
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
    this._stmtRemovePullRequest.run(repo, number)
  }

  /** Remove multiple cached PRs in a single batch DELETE. */
  removePullRequests(repo: string, numbers: number[]): void {
    if (numbers.length === 0) return
    const placeholders = numbers.map(() => "?").join(",")
    this.db
      .query(`DELETE FROM pull_requests WHERE repo = ? AND number IN (${placeholders})`)
      .run(repo, ...numbers)
  }

  /** Remove cached PRs whose numbers are not in the given set (i.e., closed/merged upstream). */
  removeClosedPullRequests(repo: string, openNumbers: Set<number>): number {
    if (openNumbers.size === 0) {
      const result = this.db.query("DELETE FROM pull_requests WHERE repo = ?").run(repo)
      return result.changes
    }
    const placeholders = [...openNumbers].map(() => "?").join(",")
    const result = this.db
      .query(`DELETE FROM pull_requests WHERE repo = ? AND number NOT IN (${placeholders})`)
      .run(repo, ...openNumbers)
    return result.changes
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
    case "label_add":
      if (!mutation.labels?.length) return true
      return runGhCommand(
        ["gh", "issue", "edit", num, ...mutation.labels.flatMap((l) => ["--add-label", l])],
        cwd,
        repo,
        mutation
      )
    case "milestone_set":
      if (mutation.milestone == null) return true
      return runGhCommand(
        ["gh", "issue", "edit", num, "--milestone", String(mutation.milestone)],
        cwd,
        repo,
        mutation
      )
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

/** Attempt REST API fallback for a mutation when GraphQL is rate-limited. */
async function tryMutationRestFallback(
  mutation: MutationPayload,
  cwd: string,
  repo: string
): Promise<boolean> {
  const num = String(mutation.number)
  debugLog(`[swiz] REST_FALLBACK_MUTATION repo=${repo} issue=#${num} type=${mutation.type}`)

  switch (mutation.type) {
    case "close": {
      await acquireGhSlot()
      const proc = Bun.spawn(
        ["gh", "api", `repos/${repo}/issues/${num}`, "-X", "PATCH", "-f", "state=closed"],
        { cwd, stdout: "pipe", stderr: "pipe" }
      )
      await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      await proc.exited
      return proc.exitCode === 0
    }
    case "comment": {
      if (!mutation.body) return true
      await acquireGhSlot()
      const proc = Bun.spawn(
        ["gh", "api", `repos/${repo}/issues/${num}/comments`, "-f", `body=${mutation.body}`],
        { cwd, stdout: "pipe", stderr: "pipe" }
      )
      await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      await proc.exited
      return proc.exitCode === 0
    }
    case "label_add": {
      if (!mutation.labels?.length) return true
      await acquireGhSlot()
      const proc = Bun.spawn(
        ["gh", "api", `repos/${repo}/issues/${num}/labels`, "-X", "POST", "--input", "-"],
        {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
          stdin: new Response(JSON.stringify({ labels: mutation.labels })),
        }
      )
      await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      await proc.exited
      return proc.exitCode === 0
    }
    case "milestone_set": {
      if (mutation.milestone == null) return true
      await acquireGhSlot()
      const proc = Bun.spawn(
        [
          "gh",
          "api",
          `repos/${repo}/issues/${num}`,
          "-X",
          "PATCH",
          "-f",
          `milestone=${String(mutation.milestone)}`,
        ],
        { cwd, stdout: "pipe", stderr: "pipe" }
      )
      await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      await proc.exited
      return proc.exitCode === 0
    }
    case "create": {
      if (!mutation.title) return false
      await acquireGhSlot()
      const payload: Record<string, unknown> = { title: mutation.title }
      if (mutation.body) payload.body = mutation.body
      if (mutation.labels?.length) payload.labels = mutation.labels
      const proc = Bun.spawn(["gh", "api", `repos/${repo}/issues`, "-X", "POST", "--input", "-"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        stdin: new Response(JSON.stringify(payload)),
      })
      await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      await proc.exited
      return proc.exitCode === 0
    }
    default:
      return false
  }
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
  issues: { upserted: number; removed: number }
  pullRequests: { upserted: number; removed: number }
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
    issues: { upserted: 0, removed: 0 },
    pullRequests: { upserted: 0, removed: 0 },
    ciStatuses: { upserted: 0 },
  }

  const [issues, prs, runs, closedIssues, closedPrs] = await Promise.all([
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
    // Backfill: fetch recently-closed issues/PRs to explicitly purge stale rows
    fetchGhJson<{ number: number }[]>(
      ["issue", "list", "--state", "closed", "--json", "number", "--limit", "30"],
      cwd
    ),
    fetchGhJson<{ number: number }[]>(
      ["pr", "list", "--state", "closed", "--json", "number", "--limit", "30"],
      cwd
    ),
  ])

  if (issues) {
    if (issues.length > 0) s.upsertIssues(repo, issues)
    result.issues.removed = s.removeClosedIssues(repo, new Set(issues.map((i) => i.number)))
    result.issues.upserted = issues.length
  }
  // Backfill: explicitly remove recently-closed issues even if the open fetch failed
  if (closedIssues?.length) {
    s.removeIssues(
      repo,
      closedIssues.map((ci) => ci.number)
    )
    result.issues.removed += closedIssues.length
  }

  if (prs) {
    if (prs.length > 0) s.upsertPullRequests(repo, prs)
    result.pullRequests.removed = s.removeClosedPullRequests(
      repo,
      new Set(prs.map((p) => p.number))
    )
    result.pullRequests.upserted = prs.length
  }
  // Backfill: explicitly remove recently-closed/merged PRs
  if (closedPrs?.length) {
    s.removePullRequests(
      repo,
      closedPrs.map((cp) => cp.number)
    )
    result.pullRequests.removed += closedPrs.length
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
export function isGraphQLRateLimited(stderr: string): boolean {
  return stderr.includes("API rate limit") && stderr.includes("GraphQL")
}

interface RestFallbackMapping {
  endpoint: string
  /** Transforms the raw REST response body into the shape expected by the caller. */
  normalize?: (raw: unknown) => unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
}

function getGhFlagValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag)
  if (index === -1 || index + 1 >= args.length) return null
  return args[index + 1] ?? null
}

function getRestListState(args: string[]): "open" | "closed" | "all" {
  const state = getGhFlagValue(args, "--state")
  if (state === "closed" || state === "all" || state === "open") return state
  return "open"
}

function getRestPerPage(args: string[], fallback: number): number {
  const raw = Number.parseInt(getGhFlagValue(args, "--limit") ?? "", 10)
  if (!Number.isFinite(raw) || raw < 1) return fallback
  return Math.min(raw, 100)
}

function buildRepoListEndpoint(
  resource: "issues" | "pulls",
  args: string[],
  fallbackPerPage = 100
): string {
  const params = new URLSearchParams({
    state: getRestListState(args),
    per_page: String(getRestPerPage(args, fallbackPerPage)),
  })
  return `repos/{owner}/{repo}/${resource}?${params.toString()}`
}

function normalizeRestUser(user: unknown): { login: string } | null {
  const record = asRecord(user)
  const login = typeof record?.login === "string" ? record.login : null
  return login ? { login } : null
}

function normalizeRestLabels(
  labels: unknown
): Array<{ name: string; color: string; description: string }> {
  if (!Array.isArray(labels)) return []
  return labels
    .map((label) => {
      const record = asRecord(label)
      const name = typeof record?.name === "string" ? record.name : null
      if (!name) return null
      return {
        name,
        color: typeof record?.color === "string" ? record.color : "",
        description: typeof record?.description === "string" ? record.description : "",
      }
    })
    .filter(
      (label): label is { name: string; color: string; description: string } => label !== null
    )
}

function normalizeRestAssignees(assignees: unknown): Array<{ login: string }> {
  if (!Array.isArray(assignees)) return []
  return assignees
    .map((assignee) => normalizeRestUser(assignee))
    .filter((assignee): assignee is { login: string } => assignee !== null)
}

function normalizeRestIssues(raw: unknown): Array<{
  number: number
  title: string
  state: string
  labels: Array<{ name: string; color: string; description: string }>
  author: { login: string } | null
  assignees: Array<{ login: string }>
  updatedAt: string
}> {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => asRecord(entry))
    .filter(
      (issue): issue is Record<string, unknown> => issue !== null && !("pull_request" in issue)
    )
    .map((issue) => {
      const number = typeof issue.number === "number" ? issue.number : null
      const title = typeof issue.title === "string" ? issue.title : null
      const state = typeof issue.state === "string" ? issue.state : "open"
      const updatedAt = typeof issue.updated_at === "string" ? issue.updated_at : null
      if (!number || !title || !updatedAt) return null
      return {
        number,
        title,
        state,
        labels: normalizeRestLabels(issue.labels),
        author: normalizeRestUser(issue.user),
        assignees: normalizeRestAssignees(issue.assignees),
        updatedAt,
      }
    })
    .filter(
      (
        issue
      ): issue is {
        number: number
        title: string
        state: string
        labels: Array<{ name: string; color: string; description: string }>
        author: { login: string } | null
        assignees: Array<{ login: string }>
        updatedAt: string
      } => issue !== null
    )
}

function normalizeRestPullRequests(raw: unknown): Array<{
  number: number
  title: string
  state: string
  headRefName: string
  author: { login: string } | null
  reviewDecision: string
  statusCheckRollup: unknown[]
  mergeable: string
  url: string
  createdAt: string
  updatedAt: string
}> {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => asRecord(entry))
    .filter((pr): pr is Record<string, unknown> => pr !== null)
    .map((pr) => {
      const number = typeof pr.number === "number" ? pr.number : null
      const title = typeof pr.title === "string" ? pr.title : null
      const state = typeof pr.state === "string" ? pr.state : "open"
      const url = typeof pr.html_url === "string" ? pr.html_url : null
      const createdAt = typeof pr.created_at === "string" ? pr.created_at : null
      const updatedAt = typeof pr.updated_at === "string" ? pr.updated_at : null
      const head = asRecord(pr.head)
      const headRefName = typeof head?.ref === "string" ? head.ref : null
      if (!number || !title || !url || !createdAt || !updatedAt || !headRefName) return null
      return {
        number,
        title,
        state,
        headRefName,
        author: normalizeRestUser(pr.user),
        reviewDecision: "",
        statusCheckRollup: [] as unknown[],
        mergeable:
          typeof pr.mergeable === "string"
            ? pr.mergeable
            : pr.mergeable === true
              ? "MERGEABLE"
              : pr.mergeable === false
                ? "CONFLICTING"
                : "UNKNOWN",
        url,
        createdAt,
        updatedAt,
      }
    })
    .filter(
      (
        pr
      ): pr is {
        number: number
        title: string
        state: string
        headRefName: string
        author: { login: string } | null
        reviewDecision: string
        statusCheckRollup: unknown[]
        mergeable: string
        url: string
        createdAt: string
        updatedAt: string
      } => pr !== null
    )
}

/**
 * Lookup table mapping `gh <entity> list` commands to REST API fallbacks.
 * The `normalize` function adapts REST response shapes to match gh CLI output shapes.
 */
const REST_FALLBACK_MAP: Record<string, RestFallbackMapping> = {
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
  if (args[0] === "issue" && args[1] === "list") {
    return {
      endpoint: buildRepoListEndpoint("issues", args),
      normalize: normalizeRestIssues,
    }
  }
  if (args[0] === "pr" && args[1] === "list") {
    return {
      endpoint: buildRepoListEndpoint("pulls", args),
      normalize: normalizeRestPullRequests,
    }
  }
  return REST_FALLBACK_MAP[`${args[0]}:${args[1]}`] ?? null
}

/** Fetch via REST API for a mapped gh list command. */
async function fetchViaRest(endpoint: string, cwd: string): Promise<unknown> {
  await acquireGhSlot()
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
 * Fetch a mapped gh list command via REST API.
 * Returns null if no REST mapping exists for the command or if REST fails.
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
  debugLog(`[swiz] REST_QUERY for ${args.join(" ")}`)
  const raw = await fetchViaRest(mapping.endpoint, cwd)
  if (raw === null) return null
  return (mapping.normalize ? mapping.normalize(raw) : raw) as T
}

/** Run a gh subcommand and parse JSON output. Returns null on failure.
 *  Prefers REST API for mapped list commands and falls back to gh subcommands only when REST fails. */
async function fetchGhJson<T>(args: string[], cwd: string): Promise<T | null> {
  const hasRestMapping = ghListToRestFallback(args) !== null
  if (hasRestMapping) {
    const restResult = await tryRestFallback<T>(args, cwd)
    if (restResult !== null) {
      debugLog(`[swiz] REST_PRIMARY for ${args.join(" ")}`)
      return restResult
    }
    debugLog(`[swiz] REST_PRIMARY_FAILED for ${args.join(" ")}; falling back to gh`)
  }

  await acquireGhSlot()
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
    return null
  }
  let parsed: T | null = null
  try {
    parsed = JSON.parse(stdout) as T
  } catch {
    return null
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

/** Get or create a shared IssueStore instance.
 *  Falls back to a no-op store if SQLite is unavailable (e.g. locked DB,
 *  missing directory, corrupted file). Callers' existing gh CLI fallbacks
 *  will kick in when the no-op store returns empty results. */
let sharedStore: IssueStore | null = null

export function getIssueStore(dbPath?: string): IssueStore {
  if (!sharedStore) {
    try {
      sharedStore = new IssueStore(dbPath)
    } catch (err) {
      debugLog(`[swiz] IssueStore init failed, using no-op fallback: ${err}`)
      sharedStore = createNoOpStore()
    }
  }
  return sharedStore
}

/** No-op IssueStore used when SQLite is unavailable. Returns empty results
 *  for all reads, causing callers to fall through to their existing async
 *  ghJsonViaDaemon / gh CLI fallback paths (which route through the daemon
 *  HTTP API automatically). Writes are silently dropped.
 *
 *  The IssueStore interface is synchronous, so the no-op proxy cannot make
 *  async daemon HTTP calls directly — instead it returns empty, and the
 *  callers' async fallback paths handle daemon routing.
 *
 *  Emits a one-time warning on first read and logs suppressed operation
 *  count on process exit for full observability. */
let noOpExitHandlerRegistered = false

function createNoOpStore(): IssueStore {
  const noop = {} as IssueStore
  let warnedOnce = false
  let suppressedOps = 0
  const READ_LIST_METHODS = new Set(["listIssues", "listPullRequests", "listCiBranchRuns"])
  const READ_GET_METHODS = new Set([
    "getIssue",
    "getPullRequest",
    "getCiStatus",
    "getCiBranchRun",
    "getPrBranchDetail",
  ])

  const warnOnFirstRead = (method: string | symbol) => {
    if (!warnedOnce) {
      warnedOnce = true
      debugLog(
        `[swiz] IssueStore SQLite unavailable — ${String(method)}() returning empty; callers will use daemon/gh CLI fallback`
      )
    }
  }

  if (!noOpExitHandlerRegistered) {
    noOpExitHandlerRegistered = true
    process.on("exit", () => {
      if (suppressedOps > 0) {
        debugLog(`[swiz] IssueStore no-op: ${suppressedOps} operations suppressed during session`)
      }
    })
  }

  const handler: ProxyHandler<IssueStore> = {
    get(_target, prop) {
      if (prop === "close") return () => {}
      if (READ_LIST_METHODS.has(prop as string)) {
        return (..._args: unknown[]) => {
          suppressedOps++
          warnOnFirstRead(prop)
          return []
        }
      }
      if (READ_GET_METHODS.has(prop as string)) {
        return (..._args: unknown[]) => {
          suppressedOps++
          warnOnFirstRead(prop)
          return null
        }
      }
      if (prop === "pendingMutationCount" || prop === "removeClosedIssues") {
        return () => {
          suppressedOps++
          return 0
        }
      }
      if (prop === "drainPendingMutations") {
        return () => {
          suppressedOps++
          return []
        }
      }
      // Write methods are silent no-ops
      return (..._args: unknown[]) => {
        suppressedOps++
      }
    },
  }
  return new Proxy(noop, handler)
}

/** Reset the shared store (for testing). */
export function resetIssueStore(): void {
  sharedStore?.close()
  sharedStore = null
}

// ─── Daemon-backed async store ─────────────────────────────────────────────

const DAEMON_FALLBACK_PORT = Number(process.env.SWIZ_DAEMON_PORT ?? "7943")
const DAEMON_FALLBACK_TIMEOUT_MS = 2_000

/**
 * Async issue store that reads from the daemon's /gh-query HTTP API.
 * Used when the primary SQLite store is unavailable — provides direct
 * daemon routing at the store level rather than relying on caller fallbacks.
 *
 * Usage:
 *   const store = getDaemonBackedStore()
 *   const issues = await store.listIssues<Issue>(repo)
 */
export class DaemonBackedIssueStore {
  private daemonAvailable: boolean | null = null

  private async query<T>(args: string[]): Promise<T | null> {
    if (this.daemonAvailable === false) return null
    try {
      const resp = await fetch(`http://127.0.0.1:${DAEMON_FALLBACK_PORT}/gh-query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args, cwd: ".", ttlMs: 300_000 }),
        signal: AbortSignal.timeout(DAEMON_FALLBACK_TIMEOUT_MS),
      })
      if (!resp.ok) {
        this.daemonAvailable = false
        return null
      }
      this.daemonAvailable = true
      const data = (await resp.json()) as { value: T | null }
      return data.value
    } catch {
      this.daemonAvailable = false
      return null
    }
  }

  async listIssues<T = unknown>(repo: string): Promise<T[]> {
    const result = await this.query<T[]>([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--json",
      "number,title,labels,author,assignees",
    ])
    return result ?? []
  }

  async listPullRequests<T = unknown>(repo: string): Promise<T[]> {
    const result = await this.query<T[]>([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--json",
      "number,title,url,reviewDecision,mergeable,createdAt,author",
    ])
    return result ?? []
  }

  async getIssue<T = unknown>(repo: string, number: number): Promise<T | null> {
    const result = await this.query<T[]>([
      "issue",
      "view",
      "--repo",
      repo,
      String(number),
      "--json",
      "number,title,labels,author,assignees,body,state",
    ])
    return Array.isArray(result) ? (result[0] ?? null) : result
  }

  get isDaemonAvailable(): boolean | null {
    return this.daemonAvailable
  }
}

let sharedDaemonStore: DaemonBackedIssueStore | null = null

/** Get a shared DaemonBackedIssueStore instance for async reads via daemon HTTP API. */
export function getDaemonBackedStore(): DaemonBackedIssueStore {
  if (!sharedDaemonStore) {
    sharedDaemonStore = new DaemonBackedIssueStore()
  }
  return sharedDaemonStore
}

/** Reset the shared daemon store (for testing). */
export function resetDaemonBackedStore(): void {
  sharedDaemonStore = null
}
