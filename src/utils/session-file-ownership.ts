import { relative, resolve } from "node:path"
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
  for (const edit of edits) {
    const filePath = relative(gitRoot, resolve(cwd, edit.file_path))
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
    const normalizedFile = relative(gitRoot, resolve(gitRoot, file))
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
    const { projectKeyFromCwd } = await import("../transcript-utils.ts")
    const projectKey = projectKeyFromCwd(cwd)
    if (!projectKey) return { known: false, reason: "missing-project" }
    if (files.length === 0) {
      return { known: true, ownership: { editedByUs: [], editedByOthers: [], unattributed: [] } }
    }
    const [{ getIssueStore, getIssueStoreReader }, { git }] = await Promise.all([
      import("../issue-store.ts"),
      import("../git-helpers.ts"),
    ])
    const store = getIssueStore()
    if (store.isNoOp) return { known: false, reason: "store-unavailable" }

    const ownEdits = await getIssueStoreReader().listSessionEdits<SessionFileEdit>(
      projectKey,
      sessionId
    )
    const otherEdits = store.listOtherSessionEdits(
      projectKey,
      sessionId,
      nowMs - CONCURRENT_EDIT_WINDOW_MS
    )
    const gitRoot = (await git(["rev-parse", "--show-toplevel"], cwd)).trim()
    if (!gitRoot) return { known: false, reason: "git-root-unavailable" }

    return {
      known: true,
      ownership: classifySessionFileOwnership({ cwd, gitRoot, files, ownEdits, otherEdits }),
    }
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
    "  Edited in this session (recorded):",
    ownership.editedByUs,
    maxFiles
  )

  const otherLimit = Math.max(5, maxFiles - ownership.editedByUs.length)
  appendFileSection(
    sections,
    "  Edited by another active session (confirmed):",
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
