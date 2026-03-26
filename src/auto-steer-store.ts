/**
 * SQLite-backed auto-steer queue with two-layer deduplication and optional TTL.
 *
 * Supports multiple pending messages per session and delivery triggers
 * (next_turn, after_commit, after_all_tasks_complete, on_session_stop).
 *
 * ## TTL (time-to-live)
 *
 * Each message can carry an optional `ttlMs`. When present, the message
 * expires if not consumed within `created_at + ttlMs`. Expired messages
 * are silently skipped during `consume()` / `hasPending()` and do NOT
 * count as "delivered" for dedup purposes — they are treated as if they
 * never existed. Delivered messages (actually sent) retain their dedup
 * effect regardless of their original TTL.
 *
 * ## Dedup architecture
 *
 * **Enqueue-side** (`enqueue()`): Rejects if an identical message (same
 * session + trigger + text) is already pending (and not expired) OR was
 * delivered within the dedup window (60 s).
 *
 * **Send-side** (consumer hooks): Deduplicates within a single consume batch
 * so the same text isn't typed into the terminal twice in one cycle. The
 * `wasRecentlyDelivered()` helper is available for direct-send paths that
 * bypass the queue (e.g. stop-block auto-steer).
 *
 * **Retention**: Delivered rows are kept for the duration of the dedup window.
 * Expired undelivered rows and old delivered rows are cleaned up by `prune()`.
 *
 * Uses Bun's built-in bun:sqlite — no external dependencies.
 */

import { Database, type Statement } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

import { getHomeDirWithFallback } from "./home.ts"
import { projectKeyFromCwd } from "./project-key.ts"

export { projectKeyFromCwd }

// ─── Types ──────────────────────────────────────────────────────────────────

export type AutoSteerTrigger =
  | "next_turn"
  | "after_commit"
  | "after_all_tasks_complete"
  | "on_session_stop"

export interface QueuedAutoSteerRequest {
  id: number
  sessionId: string
  message: string
  trigger: AutoSteerTrigger
  createdAt: number
  deliveredAt: number | null
}

// ─── Store ──────────────────────────────────────────────────────────────────

export function getAutoSteerDbPath(): string {
  const home = getHomeDirWithFallback("/tmp")
  return join(home, ".swiz", "auto-steer.db")
}

let _instance: AutoSteerStore | null = null

export function getAutoSteerStore(dbPath?: string): AutoSteerStore {
  if (!_instance) {
    _instance = new AutoSteerStore(dbPath)
  }
  return _instance
}

/** Reset the singleton (for tests). */
export function resetAutoSteerStore(): void {
  if (_instance) {
    _instance.close()
    _instance = null
  }
}

/** Default dedup window (ms): skip enqueue/send if identical message was delivered within this period. */
const DEDUP_WINDOW_MS = 60_000

export class AutoSteerStore {
  private db: Database
  private _stmtEnqueue!: Statement
  private _stmtConsume!: Statement
  private _stmtMarkDelivered!: Statement
  private _stmtPendingDuplicate!: Statement
  private _stmtRecentlyDelivered!: Statement
  private _stmtPruneOld!: Statement
  private _stmtPending!: Statement<{
    id: number
    session_id: string
    message: string
    trigger: string
    created_at: number
  }>

  constructor(dbPath?: string) {
    const path = dbPath ?? getAutoSteerDbPath()
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.run("PRAGMA journal_mode=WAL")
    this.migrate()
    this.prepareStatements()
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS auto_steer_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        message TEXT NOT NULL,
        trigger_type TEXT NOT NULL DEFAULT 'next_turn',
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        ttl_ms INTEGER,
        project_key TEXT
      )
    `)
    // Migrations: add columns if missing (existing DBs)
    for (const col of ["ttl_ms INTEGER", "project_key TEXT"]) {
      try {
        this.db.run(`ALTER TABLE auto_steer_queue ADD COLUMN ${col}`)
      } catch {
        // Column already exists — ignore
      }
    }
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_auto_steer_pending
        ON auto_steer_queue (session_id, trigger_type, delivered_at)
        WHERE delivered_at IS NULL
    `)
  }

  private prepareStatements(): void {
    this._stmtEnqueue = this.db.prepare(
      "INSERT INTO auto_steer_queue (session_id, message, trigger_type, created_at, ttl_ms, project_key) VALUES (?, ?, ?, ?, ?, ?)"
    )
    // Consume: select undelivered rows that haven't expired — scoped by session_id (delivery is per-session).
    this._stmtConsume = this.db.prepare(
      `SELECT id, session_id, message, trigger_type as trigger, created_at
       FROM auto_steer_queue
       WHERE session_id = ? AND trigger_type = ? AND delivered_at IS NULL
         AND (ttl_ms IS NULL OR created_at + ttl_ms >= ?)
       ORDER BY id ASC`
    )
    this._stmtMarkDelivered = this.db.prepare(
      "UPDATE auto_steer_queue SET delivered_at = ? WHERE id = ?"
    )
    // Dedup: check if an identical message is already pending for this PROJECT (not expired, not delivered).
    // Uses project_key so the same steer across sessions on the same repo is deduped.
    // Falls back to session_id when project_key is NULL (legacy rows).
    this._stmtPendingDuplicate = this.db.prepare(
      `SELECT 1 FROM auto_steer_queue
       WHERE trigger_type = ? AND message = ? AND delivered_at IS NULL
         AND (ttl_ms IS NULL OR created_at + ttl_ms >= ?)
         AND (
           (project_key IS NOT NULL AND project_key = ?)
           OR (project_key IS NULL AND session_id = ?)
         )
       LIMIT 1`
    )
    // Dedup: check if an identical message was recently delivered for this PROJECT.
    // Delivered rows retain dedup effect regardless of their original TTL.
    this._stmtRecentlyDelivered = this.db.prepare(
      `SELECT 1 FROM auto_steer_queue
       WHERE trigger_type = ? AND message = ? AND delivered_at >= ?
         AND (
           (project_key IS NOT NULL AND project_key = ?)
           OR (project_key IS NULL AND session_id = ?)
         )
       LIMIT 1`
    )
    // Prune: remove old delivered rows AND expired undelivered rows
    this._stmtPruneOld = this.db.prepare(
      `DELETE FROM auto_steer_queue WHERE
         (delivered_at IS NOT NULL AND delivered_at < ?)
         OR (delivered_at IS NULL AND ttl_ms IS NOT NULL AND created_at + ttl_ms < ?)`
    )
    // Pending: select undelivered, non-expired rows across all triggers
    this._stmtPending = this.db.prepare(
      `SELECT id, session_id, message, trigger_type as trigger, created_at
       FROM auto_steer_queue
       WHERE session_id = ? AND delivered_at IS NULL
         AND (ttl_ms IS NULL OR created_at + ttl_ms >= ?)
       ORDER BY id ASC`
    )
  }

  /**
   * Enqueue a steering message for a session with a given trigger.
   * @param opts.ttlMs Optional TTL in milliseconds — message expires if not consumed in time.
   * @param opts.cwd   Optional working directory — used to derive project_key for cross-session dedup.
   * Dedup: skips if an identical message is already pending for this project (not expired)
   * or was delivered to any session on this project within the dedup window.
   * Returns true if enqueued, false if skipped as duplicate.
   */
  enqueue(
    sessionId: string,
    message: string,
    trigger: AutoSteerTrigger = "next_turn",
    opts?: { ttlMs?: number; cwd?: string }
  ): boolean {
    const now = Date.now()
    const projKey = opts?.cwd ? projectKeyFromCwd(opts.cwd) : null

    // Skip if identical message is already pending for this project (and not expired)
    const pendingDup = this._stmtPendingDuplicate.get(
      trigger,
      message,
      now,
      projKey ?? sessionId,
      sessionId
    )
    if (pendingDup) return false

    // Skip if identical message was recently delivered to any session on this project
    const recentCutoff = now - DEDUP_WINDOW_MS
    const recentDup = this._stmtRecentlyDelivered.get(
      trigger,
      message,
      recentCutoff,
      projKey ?? sessionId,
      sessionId
    )
    if (recentDup) return false

    this._stmtEnqueue.run(sessionId, message, trigger, now, opts?.ttlMs ?? null, projKey)
    return true
  }

  /**
   * Consume all pending, non-expired messages for a session+trigger in FIFO order.
   * Scoped by session_id — delivery is per-session.
   */
  consume(sessionId: string, trigger: AutoSteerTrigger = "next_turn"): QueuedAutoSteerRequest[] {
    const rows = this._stmtConsume.all(sessionId, trigger, Date.now()) as Array<{
      id: number
      session_id: string
      message: string
      trigger: string
      created_at: number
    }>
    const now = Date.now()
    const results: QueuedAutoSteerRequest[] = []
    for (const row of rows) {
      this._stmtMarkDelivered.run(now, row.id)
      results.push({
        id: row.id,
        sessionId: row.session_id,
        message: row.message,
        trigger: row.trigger as AutoSteerTrigger,
        createdAt: row.created_at,
        deliveredAt: now,
      })
    }
    return results
  }

  /**
   * Check if a message was recently delivered on this project (within the dedup window).
   * Delivered messages retain their dedup effect regardless of their original TTL.
   */
  wasRecentlyDelivered(
    sessionId: string,
    message: string,
    trigger: AutoSteerTrigger,
    cwd?: string
  ): boolean {
    const recentCutoff = Date.now() - DEDUP_WINDOW_MS
    const projKey = cwd ? projectKeyFromCwd(cwd) : null
    return !!this._stmtRecentlyDelivered.get(
      trigger,
      message,
      recentCutoff,
      projKey ?? sessionId,
      sessionId
    )
  }

  /** Check if any pending, non-expired messages exist for a session+trigger. */
  hasPending(sessionId: string, trigger: AutoSteerTrigger = "next_turn"): boolean {
    const rows = this._stmtConsume.all(sessionId, trigger, Date.now())
    return rows.length > 0
  }

  /** List all pending, non-expired messages for a session across all triggers. */
  listPending(sessionId: string): QueuedAutoSteerRequest[] {
    const rows = this._stmtPending.all(sessionId, Date.now()) as Array<{
      id: number
      session_id: string
      message: string
      trigger: string
      created_at: number
    }>
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      message: row.message,
      trigger: row.trigger as AutoSteerTrigger,
      createdAt: row.created_at,
      deliveredAt: null,
    }))
  }

  /** Prune old delivered rows and expired undelivered rows. */
  prune(): number {
    const cutoff = Date.now() - DEDUP_WINDOW_MS
    return this._stmtPruneOld.run(cutoff, cutoff).changes
  }

  close(): void {
    this.db.close()
  }
}
