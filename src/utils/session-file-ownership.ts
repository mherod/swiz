import { relative, resolve } from "node:path"
import { resolveSessionEditPath, sessionEditProjectKeys } from "../session-edit-identity.ts"
import {
  canonicalClaimPath,
  fileClaimIdentity,
  fileClaimProjectKey,
  indexFileClaims,
  type SessionFileClaim,
} from "../session-file-claims.ts"
import { buildConcurrentWorkGuidance } from "./concurrent-work-guidance.ts"

export interface SessionFileEdit {
  file_path: string
  updated_at?: number
}

export interface SessionFileOwnership {
  editedByUs: string[]
  editedByOthers: string[]
  unattributed: string[]
}

export interface UnknownOwnership {
  known: false
  reason:
    | "missing-cwd"
    | "missing-session"
    | "missing-project"
    | "git-status-unavailable"
    | "git-root-unavailable"
    | "store-unavailable"
    | "query-failed"
}

export type SessionFileOwnershipResult =
  | { known: true; ownership: SessionFileOwnership }
  | UnknownOwnership

export type PeerHeldFilesResult = { known: true; files: string[] } | UnknownOwnership

/** Only complete positive peer coverage can exempt dirty files from this session's gate. */
export function hasOnlyPeerOwnedChanges(
  files: readonly string[],
  result: SessionFileOwnershipResult
): boolean {
  if (!result.known || files.length === 0) return false
  const { editedByUs, editedByOthers, unattributed } = result.ownership
  if (editedByUs.length > 0 || unattributed.length > 0) return false
  const peers = new Set(editedByOthers)
  return files.every((file) => peers.has(file))
}

function hasIdentity(value: string | undefined): value is string {
  return !!value?.trim()
}

interface ClassifySessionFilesOptions {
  cwd: string
  gitRoot: string
  files: readonly string[]
  ownEdits: readonly SessionFileEdit[]
  otherEdits: readonly SessionFileEdit[]
}

function normalizedEditTimes(
  gitRoot: string,
  cwd: string,
  edits: readonly SessionFileEdit[]
): Map<string, number> {
  const editTimes = new Map<string, number>()
  const canonicalRoot = canonicalClaimPath(gitRoot)
  for (const edit of edits) {
    const path = resolveSessionEditPath(gitRoot, resolve(cwd, edit.file_path))
    if (!path) continue
    const filePath = relative(canonicalRoot, path)
    const updatedAt = edit.updated_at ?? 0
    editTimes.set(filePath, Math.max(editTimes.get(filePath) ?? 0, updatedAt))
  }
  return editTimes
}

/**
 * Classify dirty files using positive ownership evidence only.
 *
 * Absence from the current session's edit log does not prove another session
 * owns a file: tool integrations can bypass that log. Such files remain
 * unattributed unless another live session has a matching edit record.
 */
export function classifySessionFileOwnership({
  cwd,
  gitRoot,
  files,
  ownEdits,
  otherEdits,
}: ClassifySessionFilesOptions): SessionFileOwnership {
  const ownEditTimes = normalizedEditTimes(gitRoot, cwd, ownEdits)
  const otherEditTimes = normalizedEditTimes(gitRoot, cwd, otherEdits)
  const ownership: SessionFileOwnership = {
    editedByUs: [],
    editedByOthers: [],
    unattributed: [],
  }

  for (const file of files) {
    const normalizedFile = relative(
      canonicalClaimPath(gitRoot),
      canonicalClaimPath(resolve(gitRoot, file))
    )
    const ownEditAt = ownEditTimes.get(normalizedFile)
    const otherEditAt = otherEditTimes.get(normalizedFile)
    if (ownEditAt !== undefined && (otherEditAt === undefined || ownEditAt >= otherEditAt)) {
      ownership.editedByUs.push(file)
    } else if (otherEditAt !== undefined) {
      ownership.editedByOthers.push(file)
    } else {
      ownership.unattributed.push(file)
    }
  }

  return ownership
}

export async function resolveSessionFileOwnership(
  cwd: string,
  sessionId: string | undefined,
  files: readonly string[],
  nowMs = Date.now()
): Promise<SessionFileOwnership> {
  const result = await resolveSessionFileOwnershipResult(cwd, sessionId, files, nowMs)
  return result.known
    ? result.ownership
    : { editedByUs: [], editedByOthers: [], unattributed: [...files] }
}

function classifyWithClaims(
  options: ClassifySessionFilesOptions,
  claims: SessionFileClaim[],
  sessionId: string
): SessionFileOwnership {
  if (claims.length === 0) return classifySessionFileOwnership(options)
  const active = indexFileClaims(claims)
  const claimFor = (file: string) => {
    const group = active.get(fileClaimIdentity(resolve(options.gitRoot, file)))
    if (group && new Set(group.map((claim) => claim.session_id)).size > 1) {
      throw new Error("Conflicting legacy reservations leave file ownership ambiguous")
    }
    return group?.[0]
  }
  const unclaimed = options.files.filter((file) => !claimFor(file))
  const ownership = classifySessionFileOwnership({ ...options, files: unclaimed })
  for (const file of options.files) {
    const claim = claimFor(file)
    if (claim)
      ownership[claim.session_id === sessionId ? "editedByUs" : "editedByOthers"].push(file)
  }
  return ownership
}

/** Preserve query certainty separately from the three attribution buckets. */
export async function resolveSessionFileOwnershipResult(
  cwd: string | undefined,
  sessionId: string | undefined,
  files: readonly string[],
  nowMs = Date.now()
): Promise<SessionFileOwnershipResult> {
  if (!hasIdentity(cwd)) return { known: false, reason: "missing-cwd" }
  if (!hasIdentity(sessionId)) return { known: false, reason: "missing-session" }

  try {
    const projectKeys = sessionEditProjectKeys(cwd)
    if (files.length === 0) {
      return { known: true, ownership: { editedByUs: [], editedByOthers: [], unattributed: [] } }
    }
    if (isSoleLiveSession(sessionId, await listLiveSessionIds(cwd, nowMs))) {
      return {
        known: true,
        ownership: { editedByUs: [...files], editedByOthers: [], unattributed: [] },
      }
    }
    const [{ getIssueStore, getIssueStoreReader }, { git }] = await Promise.all([
      import("../issue-store.ts"),
      import("../git-helpers.ts"),
    ])
    const store = getIssueStore()
    if (store.isNoOp) return { known: false, reason: "store-unavailable" }

    const ownEdits = (
      await Promise.all(
        projectKeys.map((key) =>
          getIssueStoreReader().listSessionEdits<SessionFileEdit>(key, sessionId)
        )
      )
    ).flat()
    const otherEdits = projectKeys.flatMap((key) =>
      store.listOtherSessionEdits(key, sessionId, nowMs - CONCURRENT_EDIT_WINDOW_MS)
    )
    const gitRoot = (await git(["rev-parse", "--show-toplevel"], cwd)).trim()
    if (!gitRoot) return { known: false, reason: "git-root-unavailable" }

    const ownership = classifyWithClaims(
      { cwd, gitRoot, files, ownEdits, otherEdits },
      store.fileClaims.list(fileClaimProjectKey(cwd), nowMs),
      sessionId
    )
    return { known: true, ownership }
  } catch {
    return { known: false, reason: "query-failed" }
  }
}

/**
 * Dirty files confirmed to belong to another live session. Only a successful
 * lookup or verified clean tree can establish that no peer holds dirty files.
 */
export async function resolvePeerHeldFiles(
  cwd: string | undefined,
  sessionId: string | undefined
): Promise<PeerHeldFilesResult> {
  if (!hasIdentity(cwd)) return { known: false, reason: "missing-cwd" }
  if (!hasIdentity(sessionId)) return { known: false, reason: "missing-session" }
  try {
    const [{ getGitStatusV2 }, { projectKeyFromCwd }] = await Promise.all([
      import("./git-utils.ts"),
      import("../transcript-utils.ts"),
    ])
    if (!projectKeyFromCwd(cwd)) return { known: false, reason: "missing-project" }
    const status = await getGitStatusV2(cwd)
    if (!status) return { known: false, reason: "git-status-unavailable" }
    if (status.total === 0) return { known: true, files: [] }
    const result = await resolveSessionFileOwnershipResult(cwd, sessionId, status.lines)
    return result.known ? { known: true, files: result.ownership.editedByOthers } : result
  } catch {
    return { known: false, reason: "query-failed" }
  }
}

/** Empty only when discovery positively established that no peer holds dirty files. */
export function buildOwnershipHoldReason(result: PeerHeldFilesResult): string {
  if (!result.known) {
    return (
      `Ownership discovery is unavailable (${result.reason}). ` +
      "Inspect the intended checkout with git status --short --branch and git diff. " +
      "Confirm the project cwd and session identity, then retry ownership discovery before staging or changing branches."
    )
  }
  if (result.files.length === 0) return ""
  const shown = result.files.slice(0, 20).join(", ")
  const suffix = result.files.length > 20 ? ` (and ${result.files.length - 20} more)` : ""
  return (
    `A peer session holds uncommitted edits in this checkout: ${shown}${suffix}.\n` +
    "Do not switch branches while those edits remain; this risks stranding the peer's work. " +
    "Inspect git status --short --branch and retry ownership discovery after the peer commits."
  )
}

function appendFileSection(
  sections: string[],
  heading: string,
  files: readonly string[],
  limit: number
): void {
  if (files.length === 0) return
  sections.push(heading, ...files.slice(0, limit).map((file) => `    - ${file}`))
  if (files.length > limit) sections.push(`    ... and ${files.length - limit} more file(s)`)
}

export function appendSessionFileOwnershipContext(
  gitLine: string,
  ownership: SessionFileOwnership,
  maxFiles = 30
): string {
  const sections = ["Uncommitted files:"]
  appendFileSection(
    sections,
    "  Edited or explicitly held in this session:",
    ownership.editedByUs,
    maxFiles
  )

  const otherLimit = Math.max(5, maxFiles - ownership.editedByUs.length)
  appendFileSection(
    sections,
    "  Edited or explicitly held by another session (confirmed):",
    ownership.editedByOthers,
    otherLimit
  )

  const unknownLimit = Math.max(
    5,
    maxFiles - ownership.editedByUs.length - ownership.editedByOthers.length
  )
  appendFileSection(
    sections,
    "  Ownership not recorded (not evidence of another agent):",
    ownership.unattributed,
    unknownLimit
  )

  if (ownership.editedByOthers.length > 0) sections.push("", buildConcurrentWorkGuidance())
  return `${gitLine}\n${sections.join("\n")}`
}

/** How recently another session must have touched a file to count as concurrent work. */
export const CONCURRENT_EDIT_WINDOW_MS = 2 * 60 * 60 * 1000

/** How recently a session's transcript must have changed for it to count as running. */
export const LIVE_SESSION_WINDOW_MS = 15 * 60 * 1000

/** Sessions (any provider) whose transcript for this directory changed within the live window. */
export async function listLiveSessionIds(
  cwd: string,
  nowMs = Date.now(),
  home?: string
): Promise<string[]> {
  try {
    const { findAllProviderSessions } = await import("../transcript-sessions.ts")
    const sessions = await findAllProviderSessions(cwd, home)
    return [
      ...new Set(
        sessions
          .filter((session) => nowMs - (session.mtime ?? 0) <= LIVE_SESSION_WINDOW_MS)
          .map((session) => session.id)
      ),
    ]
  } catch {
    return []
  }
}

/**
 * True when `sessionId` is the only session running for the directory. Its sole
 * occupant inherits every dirty file: no live peer remains to own any of them.
 */
export function isSoleLiveSession(sessionId: string, liveSessionIds: readonly string[]): boolean {
  return liveSessionIds.length === 1 && liveSessionIds[0] === sessionId
}

export interface ProjectFileOwnershipSummary {
  /** Distinct sessions that own at least one dirty file. */
  sessions: number
  /** Dirty files with an owner. */
  owned: number
  /** Dirty files with no owner. */
  unowned: number
}

interface SummarizeFileOwnershipOptions {
  cwd: string
  gitRoot: string
  files: readonly string[]
  edits: readonly (SessionFileEdit & { session_id: string })[]
  claims: SessionFileClaim[]
}

/** Latest editing session per git-root-relative path. */
function latestEditors(
  gitRoot: string,
  cwd: string,
  edits: SummarizeFileOwnershipOptions["edits"]
): Map<string, { session: string; at: number }> {
  const editors = new Map<string, { session: string; at: number }>()
  const canonicalRoot = canonicalClaimPath(gitRoot)
  for (const edit of edits) {
    const path = resolveSessionEditPath(gitRoot, resolve(cwd, edit.file_path))
    if (!path) continue
    const file = relative(canonicalRoot, path)
    const at = edit.updated_at ?? 0
    const previous = editors.get(file)
    if (!previous || at >= previous.at) editors.set(file, { session: edit.session_id, at })
  }
  return editors
}

/**
 * Project-wide attribution of dirty files, independent of any one session's viewpoint: an active
 * claim owns a file (every claiming session counts); otherwise its most recent live editor does;
 * otherwise it is unowned. Same evidence and precedence as `classifyWithClaims`.
 */
export function summarizeFileOwnership({
  cwd,
  gitRoot,
  files,
  edits,
  claims,
}: SummarizeFileOwnershipOptions): ProjectFileOwnershipSummary {
  const claimIndex = indexFileClaims(claims)
  const editors = latestEditors(gitRoot, cwd, edits)
  const canonicalRoot = canonicalClaimPath(gitRoot)
  const owners = new Set<string>()
  let owned = 0
  for (const file of files) {
    const absolute = canonicalClaimPath(resolve(gitRoot, file))
    const claimants = claimIndex.get(fileClaimIdentity(absolute))?.map((claim) => claim.session_id)
    const editor = editors.get(relative(canonicalRoot, absolute))?.session
    const fileOwners = claimants?.length ? claimants : editor ? [editor] : []
    if (fileOwners.length === 0) continue
    owned++
    for (const owner of fileOwners) owners.add(owner)
  }
  return { sessions: owners.size, owned, unowned: files.length - owned }
}

/** Ownership totals for the project's dirty files, or null when git or the store is unavailable. */
export async function resolveProjectFileOwnershipSummary(
  cwd: string,
  nowMs = Date.now()
): Promise<ProjectFileOwnershipSummary | null> {
  try {
    const [{ getGitStatusV2 }, { getIssueStore }, { git }] = await Promise.all([
      import("./git-utils.ts"),
      import("../issue-store.ts"),
      import("../git-helpers.ts"),
    ])
    const status = await getGitStatusV2(cwd)
    if (!status) return null
    if (status.total === 0) return { sessions: 0, owned: 0, unowned: 0 }
    if ((await listLiveSessionIds(cwd, nowMs)).length === 1) {
      return { sessions: 1, owned: status.total, unowned: 0 }
    }
    const store = getIssueStore()
    if (store.isNoOp) return null
    const gitRoot = (await git(["rev-parse", "--show-toplevel"], cwd)).trim()
    if (!gitRoot) return null
    // `session_id != ""` excludes nobody: every session's live edits.
    const edits = sessionEditProjectKeys(cwd).flatMap((key) =>
      store.listOtherSessionEdits(key, "", nowMs - CONCURRENT_EDIT_WINDOW_MS)
    )
    const claims = store.fileClaims.list(fileClaimProjectKey(cwd), nowMs)
    return summarizeFileOwnership({ cwd, gitRoot, files: status.lines, edits, claims })
  } catch {
    return null
  }
}
