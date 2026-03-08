/**
 * Local SQLite-backed issue store with GitHub sync fallback.
 * Uses Bun's built-in SQLite support — no external dependencies.
 *
 * Two tables:
 * - `issues`: TTL-cached read store (refreshed on successful gh calls)
 * - `pending_mutations`: Queued mutations for offline replay
 */

import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

import { debugLog } from "./debug.ts"

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

export interface MutationPayload {
  type: "close" | "comment" | "resolve"
  number: number
  body?: string
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
    this.db.exec("PRAGMA journal_mode=WAL")
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        data TEXT NOT NULL,
        synced_at INTEGER NOT NULL,
        PRIMARY KEY (repo, number)
      );
      CREATE TABLE IF NOT EXISTS pending_mutations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        mutation TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_attempt INTEGER,
        attempts INTEGER DEFAULT 0
      );
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
  store?: IssueStore
): Promise<ReplayResult> {
  const s = store ?? getIssueStore()
  const pending = s.getPendingMutations(repo)
  const result: ReplayResult = { replayed: 0, failed: 0, discarded: 0 }

  for (const row of pending) {
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
      if (mutation.type === "close" || mutation.type === "resolve") {
        s.removeIssue(repo, mutation.number)
      }
      result.replayed++
    } else {
      s.markAttempted(row.id)
      result.failed++
    }
  }

  return result
}

/** Execute a single mutation against live GitHub. Returns true on success. */
async function executeMutation(
  mutation: MutationPayload,
  cwd: string,
  repo: string
): Promise<boolean> {
  const num = String(mutation.number)

  switch (mutation.type) {
    case "close": {
      return runGhIssueCommand(["gh", "issue", "close", num], cwd, repo, mutation)
    }
    case "comment": {
      if (!mutation.body) return true // nothing to post
      return runGhIssueCommand(
        ["gh", "issue", "comment", num, "--body", mutation.body],
        cwd,
        repo,
        mutation
      )
    }
    case "resolve": {
      // Resolve = comment (if body) + close
      if (mutation.body) {
        const ok = await runGhIssueCommand(
          ["gh", "issue", "comment", num, "--body", mutation.body],
          cwd,
          repo,
          { ...mutation, type: "comment" }
        )
        if (!ok) return false
      }
      return runGhIssueCommand(["gh", "issue", "close", num], cwd, repo, {
        ...mutation,
        type: "close",
      })
    }
    default:
      return false
  }
}

async function runGhIssueCommand(
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
    const dir = cwd ?? process.cwd()
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function getDefaultDbPath(): string {
  const home = process.env.HOME ?? "/tmp"
  return join(home, ".swiz", "issues.db")
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
