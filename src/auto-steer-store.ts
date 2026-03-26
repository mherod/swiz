/**
 * SQLite-backed auto-steer queue.
 *
 * Replaces the single-file `/tmp/swiz-auto-steer-<session>.request` mechanism
 * with a durable queue that supports multiple pending messages per session and
 * delivery triggers (next_turn, after_commit, after_all_tasks_complete, on_session_stop).
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

export class AutoSteerStore {
  private db: Database
  private _stmtEnqueue!: Statement
  private _stmtConsume!: Statement
  private _stmtMarkDelivered!: Statement
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
    this._stmtPending = this.db.prepare(
      `SELECT id, session_id, message, trigger_type as trigger, created_at
       FROM auto_steer_queue
       WHERE session_id = ? AND delivered_at IS NULL
       ORDER BY id ASC`
    )
  }

  /** Enqueue a steering message for a session with a given trigger. */
  enqueue(sessionId: string, message: string, trigger: AutoSteerTrigger = "next_turn"): void {
    this._stmtEnqueue.run(sessionId, message, trigger, Date.now())
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

  close(): void {
    this.db.close()
  }
}
