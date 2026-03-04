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

/** Default TTL for cached issues: 10 minutes */
const DEFAULT_TTL_MS = 10 * 60 * 1000

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
