import type { Database } from "bun:sqlite"
import { mkdtempSync, realpathSync, rmdirSync, statSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { LRUCache } from "lru-cache"
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

const caseSensitivity = new LRUCache<string, boolean>({ max: 512, ttl: 60_000 })

/** Probe the actual containing directory, including mounts inside a project. */
function isCaseSensitive(directory: string): boolean {
  const stats = statSync(directory)
  const key = `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`
  const cached = caseSensitivity.get(key)
  if (cached !== undefined) return cached
  const probe = mkdtempSync(join(directory, ".swiz-case-A-"))
  let sensitive: boolean
  try {
    const alias = join(directory, basename(probe).toLowerCase())
    try {
      const actual = statSync(probe)
      const alternate = statSync(alias)
      sensitive = actual.dev !== alternate.dev || actual.ino !== alternate.ino
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error
      sensitive = true
    }
  } finally {
    rmdirSync(probe)
  }
  caseSensitivity.set(key, sensitive)
  return sensitive
}

/**
 * Compare current filesystem targets without rewriting display or persisted paths.
 * Existing aliases use realpath; missing suffixes inherit their nearest directory's
 * case semantics. Re-evaluate stored paths too, so creating a file keeps its owner.
 */
export function fileClaimIdentity(path: string): string {
  let candidate = resolve(path)
  const missing: string[] = []
  for (;;) {
    let existing: string
    try {
      existing = realpathSync(candidate)
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error
      const parent = dirname(candidate)
      if (parent === candidate) throw error
      missing.unshift(basename(candidate))
      candidate = parent
      continue
    }
    if (missing.length === 0) return existing
    let suffix = missing.join("/")
    if (!isCaseSensitive(existing)) {
      if (/[^\u0020-\u007e]/.test(suffix)) {
        throw new Error("Cannot establish case equivalence for a missing non-ASCII path")
      }
      suffix = suffix.toLowerCase()
    }
    return resolve(existing, suffix)
  }
}

/** Keep every legacy alias: choosing one row could silently discard a peer owner. */
export function indexFileClaims(claims: SessionFileClaim[]): Map<string, SessionFileClaim[]> {
  const index = new Map<string, SessionFileClaim[]>()
  for (const claim of claims) {
    const identity = fileClaimIdentity(claim.file_path)
    const group = index.get(identity) ?? []
    group.push(claim)
    index.set(identity, group)
  }
  return index
}

interface ClaimMutation {
  projectKey: string
  sessionId: string
  paths: string[]
  action: "claim" | "hold" | "release"
  leaseMs: number
  lane?: string
  clock?: () => number
}

type LockedClaimMutation = ClaimMutation & { now: number }

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
    return this.db
      .transaction(() => this.mutateLocked({ ...input, now: (input.clock ?? Date.now)() }))
      .immediate()
  }

  private mutateLocked(input: LockedClaimMutation): ClaimMutationResult {
    const { projectKey, sessionId, action, now } = input
    const paths = new Map<string, string>()
    for (const path of input.paths) {
      const identity = fileClaimIdentity(path)
      if (!paths.has(identity)) paths.set(identity, path)
    }
    const current = indexFileClaims(this.list(projectKey, now))
    const selected = [...paths.keys()].flatMap((identity) => current.get(identity) ?? [])
    const conflicts = [...paths.keys()].flatMap((identity) => {
      const group = current.get(identity) ?? []
      // An ambiguous legacy group can be unwound by releasing only our rows.
      if (action === "release" && group.some((claim) => claim.session_id === sessionId)) return []
      return group.filter((claim) => claim.session_id !== sessionId)
    })
    const missing =
      action === "hold"
        ? [...paths].filter(([identity]) => !current.has(identity)).map(([, path]) => path)
        : []
    if (conflicts.length || missing.length) {
      return { ok: false, claims: selected, conflicts, missing, released: [] }
    }
    this.db.query("DELETE FROM session_file_claims WHERE expires_at <= ?").run(now)
    if (action === "release") {
      const owned = selected.filter((claim) => claim.session_id === sessionId)
      for (const claim of owned) {
        this.db
          .query(
            "DELETE FROM session_file_claims WHERE project_key = ? AND file_path = ? AND session_id = ?"
          )
          .run(projectKey, claim.file_path, sessionId)
      }
      return {
        ok: true,
        claims: selected.filter((claim) => claim.session_id !== sessionId),
        conflicts: [],
        missing: [],
        released: owned.map((claim) => claim.file_path),
      }
    }
    const storagePaths = [...paths].flatMap(([identity, path]) => {
      const group = current.get(identity)
      return group ? group.map((claim) => claim.file_path) : [path]
    })
    this.upsertClaims(
      input,
      storagePaths,
      new Map(selected.map((claim) => [claim.file_path, claim]))
    )
    return {
      ok: true,
      claims: this.list(projectKey, now).filter((claim) => storagePaths.includes(claim.file_path)),
      conflicts: [],
      missing: [],
      released: [],
    }
  }

  private upsertClaims(
    input: LockedClaimMutation,
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
