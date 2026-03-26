/**
 * SQLite-backed auto-steer queue with two-layer deduplication.
 *
 * Supports multiple pending messages per session and delivery triggers
 * (next_turn, after_commit, after_all_tasks_complete, on_session_stop).
 *
 * ## Dedup architecture
 *
 * **Enqueue-side** (`enqueue()`): Rejects if an identical message (same
 * session + trigger + text) is already pending OR was delivered within the
 * dedup window (60 s). This is the primary defense against hooks that fire
 * every dispatch cycle and re-schedule the same guidance.
 *
 * **Send-side** (consumer hooks): Deduplicates within a single consume batch
 * so the same text isn't typed into the terminal twice in one cycle. The
 * `wasRecentlyDelivered()` helper is available for direct-send paths that
 * bypass the queue (e.g. stop-block auto-steer).
 *
 * **Retention**: Delivered rows are kept for the duration of the dedup window,
 * then pruned by `prune()` to prevent unbounded growth.
 *
 * Uses Bun's built-in bun:sqlite — no external dependencies.
 */

import { Database, type Statement } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

import { getHomeDirWithFallback } from "./home.ts"

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
        delivered_at INTEGER
      )
    `)
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_auto_steer_pending
        ON auto_steer_queue (session_id, trigger_type, delivered_at)
        WHERE delivered_at IS NULL
    `)
  }

  private prepareStatements(): void {
    this._stmtEnqueue = this.db.prepare(
      "INSERT INTO auto_steer_queue (session_id, message, trigger_type, created_at) VALUES (?, ?, ?, ?)"
    )
    this._stmtConsume = this.db.prepare(
      `SELECT id, session_id, message, trigger_type as trigger, created_at
       FROM auto_steer_queue
       WHERE session_id = ? AND trigger_type = ? AND delivered_at IS NULL
       ORDER BY id ASC`
    )
    this._stmtMarkDelivered = this.db.prepare(
      "UPDATE auto_steer_queue SET delivered_at = ? WHERE id = ?"
    )
    // Dedup: check if an identical message is already pending (not yet delivered)
    this._stmtPendingDuplicate = this.db.prepare(
      `SELECT 1 FROM auto_steer_queue
       WHERE session_id = ? AND trigger_type = ? AND message = ? AND delivered_at IS NULL
       LIMIT 1`
    )
    // Dedup: check if an identical message was recently delivered within the dedup window
    this._stmtRecentlyDelivered = this.db.prepare(
      `SELECT 1 FROM auto_steer_queue
       WHERE session_id = ? AND trigger_type = ? AND message = ? AND delivered_at >= ?
       LIMIT 1`
    )
    // Prune: remove delivered rows older than retention window to prevent unbounded growth
    this._stmtPruneOld = this.db.prepare(
      "DELETE FROM auto_steer_queue WHERE delivered_at IS NOT NULL AND delivered_at < ?"
    )
    this._stmtPending = this.db.prepare(
      `SELECT id, session_id, message, trigger_type as trigger, created_at
       FROM auto_steer_queue
       WHERE session_id = ? AND delivered_at IS NULL
       ORDER BY id ASC`
    )
  }

  /**
   * Enqueue a steering message for a session with a given trigger.
   * Dedup: skips if an identical message is already pending or was delivered within the dedup window.
   * Returns true if enqueued, false if skipped as duplicate.
   */
  enqueue(sessionId: string, message: string, trigger: AutoSteerTrigger = "next_turn"): boolean {
    // Skip if identical message is already pending
    const pendingDup = this._stmtPendingDuplicate.get(sessionId, trigger, message)
    if (pendingDup) return false

    // Skip if identical message was recently delivered
    const recentCutoff = Date.now() - DEDUP_WINDOW_MS
    const recentDup = this._stmtRecentlyDelivered.get(sessionId, trigger, message, recentCutoff)
    if (recentDup) return false

    this._stmtEnqueue.run(sessionId, message, trigger, Date.now())
    return true
  }

  /**
   * Consume all pending messages for a session+trigger in FIFO order.
   * Marks each as delivered atomically.
   * Returns the consumed messages (empty array if none pending).
   */
  consume(sessionId: string, trigger: AutoSteerTrigger = "next_turn"): QueuedAutoSteerRequest[] {
    const rows = this._stmtConsume.all(sessionId, trigger) as Array<{
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
   * Check if a message was recently delivered (within the dedup window).
   * Used by send-side dedup to avoid re-sending an identical message.
   */
  wasRecentlyDelivered(sessionId: string, message: string, trigger: AutoSteerTrigger): boolean {
    const recentCutoff = Date.now() - DEDUP_WINDOW_MS
    return !!this._stmtRecentlyDelivered.get(sessionId, trigger, message, recentCutoff)
  }

  /** Check if any pending messages exist for a session+trigger without consuming. */
  hasPending(sessionId: string, trigger: AutoSteerTrigger = "next_turn"): boolean {
    const rows = this._stmtConsume.all(sessionId, trigger)
    return rows.length > 0
  }

  /** List all pending (undelivered) messages for a session across all triggers. */
  listPending(sessionId: string): QueuedAutoSteerRequest[] {
    const rows = this._stmtPending.all(sessionId) as Array<{
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

  /** Prune delivered rows older than the dedup window to prevent unbounded growth. */
  prune(): number {
    const cutoff = Date.now() - DEDUP_WINDOW_MS
    return this._stmtPruneOld.run(cutoff).changes
  }

  close(): void {
    this.db.close()
  }
}
