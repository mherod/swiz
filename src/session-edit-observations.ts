import type { Database } from "bun:sqlite"

export type FileSnapshot = Record<string, string | null>

export interface EditObservation {
  project_key: string
  session_id: string
  tool_id: string
  started_at: number
  finished_at: number | null
  snapshot: string | null
  continuation: string | null
}

/** Content fingerprints only; never persist source contents or tool arguments. */
export class SessionEditObservationStore {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS session_edit_observations (
      project_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      snapshot TEXT,
      continuation TEXT,
      PRIMARY KEY (project_key, session_id, tool_id)
    )`)
    db.transaction(() => {
      const columns = db
        .query<{ name: string }, []>("PRAGMA table_info(session_edit_observations)")
        .all()
      if (!columns.some((column) => column.name === "continuation")) {
        db.exec("ALTER TABLE session_edit_observations ADD COLUMN continuation TEXT")
      }
    }).immediate()
  }

  begin(project: string, session: string, tool: string, now = Date.now()): boolean {
    return this.db
      .transaction(() => {
        this.db
          .query(`DELETE FROM session_edit_observations
        WHERE finished_at IS NOT NULL AND finished_at < ?
        AND NOT EXISTS (SELECT 1 FROM session_edit_observations WHERE finished_at IS NULL)`)
          .run(now - 86_400_000)
        return (
          this.db
            .query(`INSERT OR IGNORE INTO session_edit_observations
        (project_key, session_id, tool_id, started_at) VALUES (?, ?, ?, ?)`)
            .run(project, session, tool, now).changes > 0
        )
      })
      .immediate()
  }

  save(project: string, session: string, tool: string, snapshot: FileSnapshot): void {
    this.db
      .query(`UPDATE session_edit_observations SET snapshot = ?
      WHERE project_key = ? AND session_id = ? AND tool_id = ? AND finished_at IS NULL`)
      .run(JSON.stringify(snapshot), project, session, tool)
  }

  get(project: string, session: string, tool: string): EditObservation | null {
    return this.db
      .query<EditObservation, [string, string, string]>(
        "SELECT * FROM session_edit_observations WHERE project_key = ? AND session_id = ? AND tool_id = ?"
      )
      .get(project, session, tool)
  }

  cancel(project: string, session: string, tool: string): void {
    this.db
      .query(`DELETE FROM session_edit_observations
      WHERE project_key = ? AND session_id = ? AND tool_id = ? AND finished_at IS NULL`)
      .run(project, session, tool)
  }

  abandon(project: string, session: string, tool: string): void {
    this.db
      .query(`UPDATE session_edit_observations SET finished_at = ?, snapshot = NULL
      WHERE project_key = ? AND session_id = ? AND tool_id = ? AND finished_at IS NULL`)
      .run(Date.now(), project, session, tool)
  }

  pause(project: string, session: string, tool: string, continuation: string): void {
    this.db
      .query(`UPDATE session_edit_observations SET continuation = ?
      WHERE project_key = ? AND session_id = ? AND tool_id = ? AND finished_at IS NULL`)
      .run(continuation, project, session, tool)
  }

  pending(project: string, session: string, continuation: string): EditObservation | null {
    return this.db
      .query<EditObservation, [string, string, string]>(`SELECT * FROM session_edit_observations
      WHERE project_key = ? AND session_id = ? AND continuation = ? AND finished_at IS NULL
      ORDER BY started_at LIMIT 1`)
      .get(project, session, continuation)
  }

  /** Finish and attribute atomically, so a peer cannot start between overlap check and write. */
  finish(
    project: string,
    session: string,
    tool: string,
    after: FileSnapshot,
    now = Date.now()
  ): string[] | null {
    return this.db
      .transaction(() => {
        const observation = this.get(project, session, tool)
        if (!observation || observation.finished_at !== null) return []
        this.db
          .query(`UPDATE session_edit_observations SET finished_at = ?, snapshot = NULL
        WHERE project_key = ? AND session_id = ? AND tool_id = ?`)
          .run(now, project, session, tool)
        if (!observation.snapshot) return null
        const overlap = this.db
          .query(`SELECT 1 FROM session_edit_observations
        WHERE project_key = ? AND session_id != ? AND started_at <= ?
        AND (finished_at IS NULL OR finished_at >= ?) LIMIT 1`)
          .get(project, session, now, observation.started_at)
        if (overlap) return null
        const before = JSON.parse(observation.snapshot) as FileSnapshot
        const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
          (path) => (before[path] ?? null) !== (after[path] ?? null)
        )
        const insert = this.db.query(`INSERT INTO session_edits
        (project_key, session_id, file_path, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(project_key, session_id, file_path) DO UPDATE SET
        updated_at = MAX(session_edits.updated_at, excluded.updated_at)`)
        for (const path of changed) insert.run(project, session, path, now)
        return changed
      })
      .immediate()
  }
}
