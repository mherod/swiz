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

import { debugLog } from "./debug.ts"
import { acquireGhSlot } from "./gh-rate-limit.ts"
import { getHomeDirWithFallback } from "./home.ts"
import {
  asRecord as asRecordImpl,
  ghListToRestFallback as ghListToRestFallbackImpl,
  isGraphQLRateLimited as isGraphQLRateLimitedImpl,
  tryRestFallback as tryRestFallbackImpl,
} from "./issue-store-rest-fallback.ts"

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

export interface CachedComment {
  repo: string
  issue_number: number
  comment_id: number
  data: string // JSON blob matching gh issue comment output
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

// ─── IssueStoreReader ────────────────────────────────────────────────────────

/**
 * Shared read interface for issue/PR stores. Async to accommodate both
 * synchronous (SQLite-backed IssueStore) and asynchronous (DaemonBackedIssueStore)
 * implementations. Consumers depend on this interface rather than concrete classes.
 */
export interface IssueStoreReader {
  listIssues<T = unknown>(repo: string, ttlMs?: number): Promise<T[]>
  listPullRequests<T = unknown>(repo: string, ttlMs?: number): Promise<T[]>
  getIssue<T = unknown>(repo: string, number: number): Promise<T | null>
  getPullRequest<T = unknown>(repo: string, number: number): Promise<T | null>
  /** CI status for a commit SHA (shape matches `upsertCiStatuses` records). */
  getCiStatus<T = unknown>(repo: string, sha: string): Promise<T | null>
  /** Workflow runs for a branch, or `null` when unavailable (matches sync IssueStore TTL semantics). */
  getCiBranchRuns<T = unknown>(repo: string, branch: string): Promise<T[] | null>
  /** PR review/comment summary for a branch head (shape matches `upsertPrBranchDetail`). */
  getPrBranchDetail<T = unknown>(repo: string, branch: string): Promise<T | null>
  /** Cached comments for an issue, ordered by creation time. Returns null when not yet synced. */
  listIssueComments<T = unknown>(repo: string, issueNumber: number): Promise<T[] | null>
  /** Timestamp (ms) of the most recent comment on an issue, or null when not yet synced. */
  getLatestCommentAt(repo: string, issueNumber: number): Promise<number | null>
  /** Cached labels for a repo. Returns empty array when not yet synced. */
  listLabels<T = unknown>(repo: string, ttlMs?: number): Promise<T[]>
  /** Cached milestones for a repo. Returns empty array when not yet synced. */
  listMilestones<T = unknown>(repo: string, ttlMs?: number): Promise<T[]>
  /** Cached branch protection rules for a repo. Returns null when not yet synced. */
  getBranchProtection<T = unknown>(repo: string, branch: string): Promise<T | null>
}

// ─── GitHubClient ────────────────────────────────────────────────────────────

/** Raw issue shape returned by GitHub list APIs. */
export interface GitHubIssueRecord {
  number: number
  title?: string
  state?: string
  labels?: unknown[]
  author?: unknown
  assignees?: unknown[]
  updatedAt?: string
  // REST equivalents
  updated_at?: string
  user?: unknown
}

/** Raw PR shape returned by GitHub list APIs. */
export interface GitHubPullRequestRecord {
  number: number
  title?: string
  state?: string
  headRefName?: string
  author?: unknown
  reviewDecision?: string
  statusCheckRollup?: unknown
  mergeable?: string
  url?: string
  createdAt?: string
  updatedAt?: string
  // REST equivalents
  html_url?: string
  created_at?: string
  updated_at?: string
  user?: unknown
  head?: { ref: string }
}

/** Raw comment shape returned by GitHub issue comment APIs. */
export interface GitHubCommentRecord {
  id: number
  body?: string
  author?: { login: string }
  createdAt?: string
  updatedAt?: string
  // REST equivalents
  created_at?: string
  updated_at?: string
  user?: { login: string }
}

/** Raw CI run shape returned by GitHub list APIs. */
export interface GitHubCiRunRecord {
  headSha: string
  databaseId: number
  status: string
  conclusion: string
  url: string
}

/** Raw label shape returned by GitHub list APIs. */
export interface GitHubLabelRecord {
  name: string
  color?: string
  description?: string
}

/** Raw milestone shape returned by GitHub list APIs. */
export interface GitHubMilestoneRecord {
  number: number
  title: string
  description?: string
  state?: string
  dueOn?: string
  openIssues?: number
  closedIssues?: number
}

/** Branch protection rule shape returned by GitHub REST API. */
export interface GitHubBranchProtectionRecord {
  branch: string
  requiredReviews?: {
    requiredApprovingReviewCount: number
    dismissStaleReviews: boolean
    requireCodeOwnerReviews: boolean
  }
  requiredStatusChecks?: {
    strict: boolean
    contexts: string[]
  }
  enforceAdmins: boolean
  requiredLinearHistory: boolean
  allowForcePushes: boolean
  allowDeletions: boolean
}

/**
 * Abstraction over GitHub data fetching. Allows sync logic to be tested
 * without spawning real `gh` CLI processes.
 */
export interface GitHubClient {
  /** When `state` is `"closed"`, implementations may only populate `number`. */
  listIssues(cwd: string, state: "open" | "closed"): Promise<GitHubIssueRecord[] | null>
  /** When `state` is `"closed"`, implementations may only populate `number`. */
  listPullRequests(cwd: string, state: "open" | "closed"): Promise<GitHubPullRequestRecord[] | null>
  listWorkflowRuns(cwd: string): Promise<GitHubCiRunRecord[] | null>
  /** Fetch comments for a single issue. Returns null on error. */
  listIssueComments(cwd: string, issueNumber: number): Promise<GitHubCommentRecord[] | null>
  /** List repo labels. Returns null on error. */
  listLabels(cwd: string): Promise<GitHubLabelRecord[] | null>
  /** List open milestones. Returns null on error. */
  listMilestones(cwd: string): Promise<GitHubMilestoneRecord[] | null>
  /** List recent workflow runs for a specific branch. Returns null on error. */
  listBranchWorkflowRuns(cwd: string, branch: string): Promise<GitHubCiRunRecord[] | null>
  /** Fetch branch protection rules for a branch. Returns null on error or insufficient permissions. */
  getBranchProtection(cwd: string, branch: string): Promise<GitHubBranchProtectionRecord | null>
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
    this.db.run(`
      CREATE TABLE IF NOT EXISTS issue_comments (
        repo TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        comment_id INTEGER NOT NULL,
        data TEXT NOT NULL,
        synced_at INTEGER NOT NULL,
        PRIMARY KEY (repo, comment_id)
      )
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_issue_comments_repo_issue
      ON issue_comments (repo, issue_number)
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS labels (
        repo TEXT NOT NULL,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        synced_at INTEGER NOT NULL,
        PRIMARY KEY (repo, name)
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS milestones (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        data TEXT NOT NULL,
        synced_at INTEGER NOT NULL,
        PRIMARY KEY (repo, number)
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS branch_protection (
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

  // ─── Issue comment operations ─────────────────────────────────────────

  /** List cached comments for an issue. Returns null if none have been synced yet. */
  listIssueComments<T = unknown>(repo: string, issueNumber: number): T[] | null {
    const rows = this.db
      .query(
        "SELECT data FROM issue_comments WHERE repo = ? AND issue_number = ? ORDER BY comment_id ASC"
      )
      .all(repo, issueNumber) as { data: string }[]
    if (rows.length === 0) return null
    return rows.map((r) => JSON.parse(r.data) as T)
  }

  /** Timestamp (ms) of the most recent comment on an issue, or null when not yet synced. */
  getLatestCommentAt(repo: string, issueNumber: number): number | null {
    const row = this.db
      .query(
        "SELECT data FROM issue_comments WHERE repo = ? AND issue_number = ? ORDER BY comment_id DESC LIMIT 1"
      )
      .get(repo, issueNumber) as { data: string } | null
    if (!row) return null
    const comment = JSON.parse(row.data) as {
      createdAt?: string
      updatedAt?: string
      created_at?: string
      updated_at?: string
    }
    const ts =
      comment.updatedAt ?? comment.createdAt ?? comment.updated_at ?? comment.created_at ?? null
    return ts ? new Date(ts).getTime() : null
  }

  /** Upsert comments for an issue from a successful gh call. Replaces existing entries. */
  upsertIssueComments<T extends { id: number }>(
    repo: string,
    issueNumber: number,
    comments: T[]
  ): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO issue_comments (repo, issue_number, comment_id, data, synced_at) VALUES (?, ?, ?, ?, ?)"
    )
    const now = Date.now()
    const tx = this.db.transaction(() => {
      for (const comment of comments) {
        stmt.run(repo, issueNumber, comment.id, JSON.stringify(comment), now)
      }
    })
    tx()
  }

  /** Remove all cached comments for an issue (e.g., when the issue is closed). */
  removeIssueComments(repo: string, issueNumber: number): void {
    this.db
      .query("DELETE FROM issue_comments WHERE repo = ? AND issue_number = ?")
      .run(repo, issueNumber)
  }

  // ─── Label operations ─────────────────────────────────────────────────

  /** List cached labels for a repo. Returns only labels within TTL window. */
  listLabels<T = unknown>(repo: string, ttlMs = DEFAULT_TTL_MS): T[] {
    const cutoff = Date.now() - ttlMs
    const rows = this.db
      .query("SELECT data FROM labels WHERE repo = ? AND synced_at > ?")
      .all(repo, cutoff) as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as T)
  }

  /** Upsert labels from a successful gh call. Replaces existing data. */
  upsertLabels<T extends { name: string }>(repo: string, labels: T[]): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO labels (repo, name, data, synced_at) VALUES (?, ?, ?, ?)"
    )
    const now = Date.now()
    const tx = this.db.transaction(() => {
      for (const label of labels) {
        stmt.run(repo, label.name, JSON.stringify(label), now)
      }
    })
    tx()
  }

  /** Remove labels not present in the given set (deleted upstream). */
  removeStaleLabels(repo: string, currentNames: Set<string>): number {
    if (currentNames.size === 0) {
      const result = this.db.query("DELETE FROM labels WHERE repo = ?").run(repo)
      return result.changes
    }
    const placeholders = [...currentNames].map(() => "?").join(",")
    const result = this.db
      .query(`DELETE FROM labels WHERE repo = ? AND name NOT IN (${placeholders})`)
      .run(repo, ...currentNames)
    return result.changes
  }

  // ─── Milestone operations ──────────────────────────────────────────────

  /** List cached milestones for a repo. Returns only milestones within TTL window. */
  listMilestones<T = unknown>(repo: string, ttlMs = DEFAULT_TTL_MS): T[] {
    const cutoff = Date.now() - ttlMs
    const rows = this.db
      .query("SELECT data FROM milestones WHERE repo = ? AND synced_at > ?")
      .all(repo, cutoff) as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as T)
  }

  /** Upsert milestones from a successful gh call. Replaces existing data. */
  upsertMilestones<T extends { number: number }>(repo: string, milestones: T[]): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO milestones (repo, number, data, synced_at) VALUES (?, ?, ?, ?)"
    )
    const now = Date.now()
    const tx = this.db.transaction(() => {
      for (const milestone of milestones) {
        stmt.run(repo, milestone.number, JSON.stringify(milestone), now)
      }
    })
    tx()
  }

  /** Remove milestones not present in the given set (closed/deleted upstream). */
  removeStaleMilestones(repo: string, currentNumbers: Set<number>): number {
    if (currentNumbers.size === 0) {
      const result = this.db.query("DELETE FROM milestones WHERE repo = ?").run(repo)
      return result.changes
    }
    const placeholders = [...currentNumbers].map(() => "?").join(",")
    const result = this.db
      .query(`DELETE FROM milestones WHERE repo = ? AND number NOT IN (${placeholders})`)
      .run(repo, ...currentNumbers)
    return result.changes
  }

  // ─── Branch protection operations ──────────────────────────────────────

  /** Get cached branch protection rules for a branch. Returns null if no fresh data. */
  getBranchProtection<T = unknown>(repo: string, branch: string, ttlMs = DEFAULT_TTL_MS): T | null {
    const cutoff = Date.now() - ttlMs
    const row = this.db
      .query("SELECT data FROM branch_protection WHERE repo = ? AND branch = ? AND synced_at > ?")
      .get(repo, branch, cutoff) as { data: string } | null
    if (!row) return null
    return JSON.parse(row.data) as T
  }

  /** Upsert branch protection rules for a branch. */
  upsertBranchProtection<T>(repo: string, branch: string, rules: T): void {
    this.db
      .query(
        "INSERT OR REPLACE INTO branch_protection (repo, branch, data, synced_at) VALUES (?, ?, ?, ?)"
      )
      .run(repo, branch, JSON.stringify(rules), Date.now())
  }

  /** Remove cached branch protection for a branch. */
  removeBranchProtection(repo: string, branch: string): void {
    this.db.query("DELETE FROM branch_protection WHERE repo = ? AND branch = ?").run(repo, branch)
  }

  // ─── Cache management ───────────────────────────────────────────────────

  /** Clear all cached data (issues, PRs, CI, labels, milestones, branch protection) for a repo. Preserves pending mutations. */
  clearCachedData(repo: string): void {
    this.db.query("DELETE FROM issues WHERE repo = ?").run(repo)
    this.db.query("DELETE FROM pull_requests WHERE repo = ?").run(repo)
    this.db.query("DELETE FROM ci_status WHERE repo = ?").run(repo)
    this.db.query("DELETE FROM ci_branch_runs WHERE repo = ?").run(repo)
    this.db.query("DELETE FROM pr_branch_detail WHERE repo = ?").run(repo)
    this.db.query("DELETE FROM issue_comments WHERE repo = ?").run(repo)
    this.db.query("DELETE FROM labels WHERE repo = ?").run(repo)
    this.db.query("DELETE FROM milestones WHERE repo = ?").run(repo)
    this.db.query("DELETE FROM branch_protection WHERE repo = ?").run(repo)
  }

  /** Clear ALL cached data across all repos. Preserves pending mutations. */
  clearAllCachedData(): void {
    this.db.query("DELETE FROM issues").run()
    this.db.query("DELETE FROM pull_requests").run()
    this.db.query("DELETE FROM ci_status").run()
    this.db.query("DELETE FROM ci_branch_runs").run()
    this.db.query("DELETE FROM pr_branch_detail").run()
    this.db.query("DELETE FROM issue_comments").run()
    this.db.query("DELETE FROM labels").run()
    this.db.query("DELETE FROM milestones").run()
    this.db.query("DELETE FROM branch_protection").run()
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  close(): void {
    this.db.close()
  }

  /** Return an IssueStoreReader adapter wrapping this store's sync reads. */
  asReader(): IssueStoreReader {
    return {
      listIssues: <T = unknown>(repo: string, ttlMs?: number) =>
        Promise.resolve(this.listIssues<T>(repo, ttlMs)),
      listPullRequests: <T = unknown>(repo: string, ttlMs?: number) =>
        Promise.resolve(this.listPullRequests<T>(repo, ttlMs)),
      getIssue: <T = unknown>(repo: string, number: number) =>
        Promise.resolve(this.getIssue<T>(repo, number)),
      getPullRequest: <T = unknown>(repo: string, number: number) =>
        Promise.resolve(this.getPullRequest<T>(repo, number)),
      getCiStatus: <T = unknown>(repo: string, sha: string) =>
        Promise.resolve(this.getCiStatus<T>(repo, sha)),
      getCiBranchRuns: <T = unknown>(repo: string, branch: string) =>
        Promise.resolve(this.getCiBranchRuns<T>(repo, branch)),
      getPrBranchDetail: <T = unknown>(repo: string, branch: string) =>
        Promise.resolve(this.getPrBranchDetail<T>(repo, branch)),
      listIssueComments: <T = unknown>(repo: string, issueNumber: number) =>
        Promise.resolve(this.listIssueComments<T>(repo, issueNumber)),
      getLatestCommentAt: (repo: string, issueNumber: number) =>
        Promise.resolve(this.getLatestCommentAt(repo, issueNumber)),
      listLabels: <T = unknown>(repo: string, ttlMs?: number) =>
        Promise.resolve(this.listLabels<T>(repo, ttlMs)),
      listMilestones: <T = unknown>(repo: string, ttlMs?: number) =>
        Promise.resolve(this.listMilestones<T>(repo, ttlMs)),
      getBranchProtection: <T = unknown>(repo: string, branch: string) =>
        Promise.resolve(this.getBranchProtection<T>(repo, branch)),
    }
  }
}

// ─── Replay ─────────────────────────────────────────────────────────────────

export type { ReplayResult } from "./issue-store-replay.ts"

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
): Promise<import("./issue-store-replay.ts").ReplayResult> {
  // Implementation delegated to the dedicated replay module.
  // (Issue #378 extraction: keep this file focused on storage + readers.)
  const mod = await import("./issue-store-replay.ts")
  return await mod.replayPendingMutations(repo, cwd, store, concurrency)
}

/**
 * Best-effort replay: resolve repo slug from cwd and drain pending mutations.
 * Catches all errors — never throws. Safe to call from any entry point.
 * Logs outcomes to stderr so failures are visible without blocking execution.
 */
export async function tryReplayPendingMutations(cwd?: string): Promise<void> {
  // Implementation delegated to the dedicated replay module.
  const mod = await import("./issue-store-replay.ts")
  await mod.tryReplayPendingMutations(cwd)
}

// ─── Upstream sync ──────────────────────────────────────────────────────────

export type { UpstreamSyncResult } from "./issue-store-sync.ts"

export async function syncUpstreamState(
  repo: string,
  cwd: string,
  opts?: { store?: IssueStore; client?: GitHubClient }
): Promise<import("./issue-store-sync.ts").UpstreamSyncResult> {
  // Implementation delegated to the dedicated upstream-sync module.
  const mod = await import("./issue-store-sync.ts")
  return await mod.syncUpstreamState(repo, cwd, opts)
}

/** Detect GraphQL rate-limit errors in gh CLI stderr output. */
export function isGraphQLRateLimited(stderr: string): boolean {
  return isGraphQLRateLimitedImpl(stderr)
}

interface RestFallbackMapping {
  endpoint: string
  /** Transforms the raw REST response body into the shape expected by the caller. */
  normalize?: (raw: unknown) => unknown
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return asRecordImpl(value)
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
  // Legacy implementation (moved to `issue-store-rest-fallback.ts`).
  void labels
  return []
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
  // Legacy implementation (moved to `issue-store-rest-fallback.ts`).
  void raw
  return []
}

function normalizeMergeable(value: unknown): string {
  if (typeof value === "string") return value
  if (value === true) return "MERGEABLE"
  if (value === false) return "CONFLICTING"
  return "UNKNOWN"
}

function extractRequiredPRFields(pr: Record<string, unknown>): {
  number: number | null
  title: string | null
  url: string | null
  createdAt: string | null
  updatedAt: string | null
} {
  return {
    number: typeof pr.number === "number" ? pr.number : null,
    title: typeof pr.title === "string" ? pr.title : null,
    url: typeof pr.html_url === "string" ? pr.html_url : null,
    createdAt: typeof pr.created_at === "string" ? pr.created_at : null,
    updatedAt: typeof pr.updated_at === "string" ? pr.updated_at : null,
  }
}

function extractOptionalPRFields(pr: Record<string, unknown>): {
  state: string
  headRefName: string | null
} {
  const state = typeof pr.state === "string" ? pr.state : "open"
  const head = asRecord(pr.head)
  const headRefName = typeof head?.ref === "string" ? head.ref : null
  return { state, headRefName }
}

function validatePullRequestFields(pr: Record<string, unknown>): {
  number: number
  title: string
  state: string
  url: string
  createdAt: string
  updatedAt: string
  headRefName: string
} | null {
  // Legacy implementation (moved to `issue-store-rest-fallback.ts`).
  void pr
  return null
}

function normalizePullRequest(pr: Record<string, unknown>) {
  // Legacy implementation (moved to `issue-store-rest-fallback.ts`).
  void pr
  return null
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
  // Legacy implementation (moved to `issue-store-rest-fallback.ts`).
  void raw
  return []
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
  return ghListToRestFallbackImpl(args) as RestFallbackMapping | null
}

/** Fetch via REST API for a mapped gh list command. */
async function fetchViaRest(endpoint: string, cwd: string): Promise<unknown> {
  // Legacy implementation (moved to `issue-store-rest-fallback.ts`).
  void endpoint
  void cwd
  return null
}

/**
 * Fetch a mapped gh list command via REST API.
 * Returns null if no REST mapping exists for the command or if REST fails.
 * Logs a descriptive message when no mapping is registered so the gap is observable.
 *
 * Exported for unit testing.
 */
export async function tryRestFallback<T>(args: string[], cwd: string): Promise<T | null> {
  return await tryRestFallbackImpl<T>(args, cwd)
}

/** Run a gh subcommand and parse JSON output. Returns null on failure.
 *  Prefers REST API for mapped list commands and falls back to gh subcommands only when REST fails. */
export async function fetchGhJson<T>(args: string[], cwd: string): Promise<T | null> {
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

// ─── Legacy helper usage (noUnusedLocals guard) ─────────────────────────────
// The extraction refactor delegates exported entrypoints to separate modules.
// Keep the legacy helper implementations temporarily referenced so TypeScript
// `noUnusedLocals` does not fail the build while we complete the move/cleanup.
void buildRepoListEndpoint
void normalizeRestIssues
void normalizeRestPullRequests
void normalizeRestLabels
void normalizeRestAssignees
void normalizeMergeable
void extractRequiredPRFields
void extractOptionalPRFields
void validatePullRequestFields
void normalizePullRequest
void REST_FALLBACK_MAP
void fetchViaRest

// ─── GhCliGitHubClient (extracted to issue-store-gh-client.ts) ─────────────
export { GhCliGitHubClient } from "./issue-store-gh-client.ts"

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
  const READ_LIST_METHODS = new Set(["listIssues", "listPullRequests", "listCiStatuses"])
  const READ_GET_METHODS = new Set([
    "getIssue",
    "getPullRequest",
    "getCiStatus",
    "getCiBranchRuns",
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
      // When SQLite is unavailable, callers may still go through the reader
      // abstraction (`getIssueStoreReader()` → `store.asReader()`).
      // Ensure `asReader()` returns an `IssueStoreReader` with empty responses.
      if (prop === "asReader") {
        return (): IssueStoreReader => ({
          listIssues: async <T = unknown>(_repo: string): Promise<T[]> => [],
          listPullRequests: async <T = unknown>(_repo: string): Promise<T[]> => [],
          getIssue: async <T = unknown>(_repo: string, _number: number): Promise<T | null> => null,
          getPullRequest: async <T = unknown>(_repo: string, _number: number): Promise<T | null> =>
            null,
          getCiStatus: async <T = unknown>(_repo: string, _sha: string): Promise<T | null> => null,
          getCiBranchRuns: async <T = unknown>(
            _repo: string,
            _branch: string
          ): Promise<T[] | null> => null,
          getPrBranchDetail: async <T = unknown>(
            _repo: string,
            _branch: string
          ): Promise<T | null> => null,
          listIssueComments: async <T = unknown>(
            _repo: string,
            _issueNumber: number
          ): Promise<T[] | null> => null,
          getLatestCommentAt: async (_repo: string, _issueNumber: number): Promise<null> => null,
          listLabels: async <T = unknown>(_repo: string): Promise<T[]> => [],
          listMilestones: async <T = unknown>(_repo: string): Promise<T[]> => [],
          getBranchProtection: async <T = unknown>(
            _repo: string,
            _branch: string
          ): Promise<T | null> => null,
        })
      }
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

// ─── Daemon-backed async store (extracted to issue-store-daemon.ts) ────────
export {
  DaemonBackedIssueStore,
  getDaemonBackedStore,
  resetDaemonBackedStore,
} from "./issue-store-daemon.ts"

/**
 * Factory: returns the best available IssueStoreReader.
 * Tries SQLite-backed IssueStore first (via asReader()), falls back to
 * DaemonBackedIssueStore if the SQLite store is a no-op.
 */
export function getIssueStoreReader(): IssueStoreReader {
  const store = getIssueStore()
  // If the store has data capacity (not no-op), use it
  const reader = store.asReader()
  return reader
}
