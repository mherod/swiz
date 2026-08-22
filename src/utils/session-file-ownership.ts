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
  const unknown: SessionFileOwnership = {
    editedByUs: [],
    editedByOthers: [],
    unattributed: [...files],
  }
  if (!sessionId) return unknown

  try {
    const [{ getIssueStore, getIssueStoreReader }, { projectKeyFromCwd }, { git }] =
      await Promise.all([
        import("../issue-store.ts"),
        import("../transcript-utils.ts"),
        import("../git-helpers.ts"),
      ])
    const projectKey = projectKeyFromCwd(cwd)
    if (!projectKey) return unknown

    const ownEdits = await getIssueStoreReader().listSessionEdits<SessionFileEdit>(
      projectKey,
      sessionId
    )
    const otherEdits = getIssueStore().listOtherSessionEdits(
      projectKey,
      sessionId,
      nowMs - CONCURRENT_EDIT_WINDOW_MS
    )
    let gitRoot = cwd
    try {
      gitRoot = (await git(["rev-parse", "--show-toplevel"], cwd)).trim() || cwd
    } catch {
      // Keep cwd as the normalization root. Attribution remains conservative.
    }

    return classifySessionFileOwnership({ cwd, gitRoot, files, ownEdits, otherEdits })
  } catch {
    return unknown
  }
}

/**
 * Dirty files confirmed to belong to another live session; [] when the tree is
 * clean, ownership cannot be resolved, or any step fails (fail-open).
 * Shared by hooks that must not sweep or carry peer WIP (issues #841–#843).
 */
export async function resolvePeerHeldFiles(
  cwd: string,
  sessionId: string | undefined
): Promise<string[]> {
  try {
    const { getGitStatusV2 } = await import("./git-utils.ts")
    const status = await getGitStatusV2(cwd)
    if (!status || status.lines.length === 0) return []
    const ownership = await resolveSessionFileOwnership(cwd, sessionId, status.lines)
    return ownership.editedByOthers
  } catch {
    return []
  }
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
