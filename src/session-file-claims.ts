import type { Database } from "bun:sqlite"
import { realpathSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { projectKeyFromCwd } from "./project-key.ts"

export interface SessionFileClaim {
  project_key: string
  file_path: string
  session_id: string
  lane: string
  claimed_at: number
  updated_at: number
  expires_at: number
}

/** Resolve aliases even for a file whose parent directories do not exist yet. */
export function canonicalClaimPath(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error
    const parent = dirname(absolute)
    if (parent === absolute) throw error
    return resolve(canonicalClaimPath(parent), basename(absolute))
  }
}

export function fileClaimProjectKey(cwd: string): string {
  return projectKeyFromCwd(canonicalClaimPath(cwd))
}

interface ClaimMutation {
  projectKey: string
  sessionId: string
  paths: string[]
  action: "claim" | "hold" | "release"
  leaseMs: number
  lane?: string
  now: number
}

export interface ClaimMutationResult {
  ok: boolean
  claims: SessionFileClaim[]
  conflicts: SessionFileClaim[]
  missing: string[]
  released: string[]
}

/** Explicit leases share issues.db with the edit ledger, but never rewrite edit history. */
export class SessionFileClaimStore {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS session_file_claims (
      project_key TEXT NOT NULL,
      file_path TEXT NOT NULL,
      session_id TEXT NOT NULL,
      lane TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (project_key, file_path)
    )`)
  }

  list(projectKey: string, now = Date.now()): SessionFileClaim[] {
    return this.db
      .query<SessionFileClaim, [string, number]>(
        "SELECT * FROM session_file_claims WHERE project_key = ? AND expires_at > ? ORDER BY file_path"
      )
      .all(projectKey, now)
  }

  /** BEGIN IMMEDIATE makes the conflict check and the entire batch one cross-process write. */
  mutate(input: ClaimMutation): ClaimMutationResult {
    return this.db.transaction(() => this.mutateLocked(input)).immediate()
  }

  private mutateLocked(input: ClaimMutation): ClaimMutationResult {
    const { projectKey, sessionId, action, now } = input
    const paths = [...new Set(input.paths)]
    const current = new Map(this.list(projectKey, now).map((claim) => [claim.file_path, claim]))
    const selected = paths.flatMap((path) => current.get(path) ?? [])
    const conflicts = selected.filter((claim) => claim.session_id !== sessionId)
    const missing = action === "hold" ? paths.filter((path) => !current.has(path)) : []
    if (conflicts.length || missing.length) {
      return { ok: false, claims: selected, conflicts, missing, released: [] }
    }
    this.db.query("DELETE FROM session_file_claims WHERE expires_at <= ?").run(now)
    if (action === "release") {
      for (const path of paths) {
        this.db
          .query(
            "DELETE FROM session_file_claims WHERE project_key = ? AND file_path = ? AND session_id = ?"
          )
          .run(projectKey, path, sessionId)
      }
      return {
        ok: true,
        claims: [],
        conflicts: [],
        missing: [],
        released: selected.map((claim) => claim.file_path),
      }
    }
    this.upsertClaims(input, paths, current)
    return {
      ok: true,
      claims: this.list(projectKey, now).filter((claim) => paths.includes(claim.file_path)),
      conflicts: [],
      missing: [],
      released: [],
    }
  }

  private upsertClaims(
    input: ClaimMutation,
    paths: string[],
    current: Map<string, SessionFileClaim>
  ): void {
    const { projectKey, sessionId, now } = input
    const upsert = this.db.query(`INSERT INTO session_file_claims
      (project_key, file_path, session_id, lane, claimed_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_key, file_path) DO UPDATE SET
        lane = excluded.lane, updated_at = excluded.updated_at, expires_at = excluded.expires_at`)
    for (const path of paths) {
      const previous = current.get(path)
      upsert.run(
        projectKey,
        path,
        sessionId,
        input.lane ?? previous?.lane ?? "",
        previous?.claimed_at ?? now,
        now,
        Math.max(previous?.expires_at ?? 0, now + input.leaseMs)
      )
    }
  }
}
