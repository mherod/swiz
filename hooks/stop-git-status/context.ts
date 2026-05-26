/**
 * Context resolution for stop-git-status validator.
 *
 * Loads git state, collaboration settings, and determines scope.
 * Returns null (fail-open) if prerequisites not met.
 */

import type { StopHookInput } from "../../src/schemas.ts"
import {
  type CollaborationMode,
  getEffectiveSwizSettings,
  readProjectSettings,
  readSwizSettings,
} from "../../src/settings.ts"
import {
  buildConstructiveGitSummary,
  buildGitContextLine,
} from "../../src/utils/git-context-messages.ts"
import { getUnpushedCommitSummaries } from "../../src/utils/git-utils.ts"
import { getDefaultBranch, getGitStatusV2, git, isGitRepo } from "../../src/utils/hook-utils.ts"
import type { GitContext, GitStatus } from "./types.ts"

/**
 * Resolve effective collaboration and cooldown settings.
 */
async function resolveEffectiveSettings(
  input: { _effectiveSettings?: Record<string, any>; session_id?: string },
  cwd: string
): Promise<{
  collaborationMode: CollaborationMode
  pushCooldownMinutes: number
  projectSettings: Awaited<ReturnType<typeof readProjectSettings>>
  strictNoDirectMain: boolean
  trunkMode: boolean
  defaultBranch?: string
}> {
  const projectSettings = await readProjectSettings(cwd)
  if (input._effectiveSettings && typeof input._effectiveSettings.collaborationMode === "string") {
    const injected = input._effectiveSettings as {
      collaborationMode: CollaborationMode
      pushCooldownMinutes?: number
      strictNoDirectMain?: boolean
      trunkMode?: boolean
    }
    return {
      collaborationMode: injected.collaborationMode,
      pushCooldownMinutes: injected.pushCooldownMinutes ?? 0,
      projectSettings,
      strictNoDirectMain: injected.strictNoDirectMain ?? false,
      trunkMode: injected.trunkMode ?? projectSettings?.trunkMode === true,
      defaultBranch: projectSettings?.defaultBranch,
    }
  }
  const settings = await readSwizSettings()
  const full = getEffectiveSwizSettings(settings, input.session_id, projectSettings)
  return {
    collaborationMode: full.collaborationMode,
    pushCooldownMinutes: full.pushCooldownMinutes,
    projectSettings,
    strictNoDirectMain: full.strictNoDirectMain,
    trunkMode: full.trunkMode,
    defaultBranch: projectSettings?.defaultBranch,
  }
}

async function getVisibleUnpushedCommitSummaries(
  cwd: string,
  gitStatus: GitStatus
): Promise<string[]> {
  if (gitStatus.ahead <= 0) return []
  try {
    return await getUnpushedCommitSummaries(cwd)
  } catch {
    return []
  }
}

async function classifySessionFiles(
  cwd: string,
  sessionId: string | undefined,
  files: string[]
): Promise<{ editedByUs: string[]; editedByOthers: string[] }> {
  const editedByUs: string[] = []
  let editedByOthers: string[] = []

  if (!sessionId) return { editedByUs, editedByOthers: files }

  try {
    const { getIssueStoreReader } = await import("../../src/issue-store.ts")
    const { projectKeyFromCwd } = await import("../../src/transcript-utils.ts")
    const { resolve, relative } = await import("node:path")

    const projectKey = projectKeyFromCwd(cwd)
    const store = getIssueStoreReader()
    const rawEdits = await store.listSessionEdits(projectKey, sessionId)

    let gitRoot = cwd
    try {
      gitRoot = (await git(["rev-parse", "--show-toplevel"], cwd)).trim()
    } catch {
      // fallback
    }

    const dbPaths = new Set(
      rawEdits.flatMap((edit: unknown) => {
        const filePath = getSessionEditFilePath(edit)
        if (!filePath) return []
        const abs = resolve(cwd, filePath)
        return relative(gitRoot, abs)
      })
    )

    for (const file of files) {
      const normalizedFile = relative(gitRoot, resolve(gitRoot, file))
      if (dbPaths.has(normalizedFile)) {
        editedByUs.push(file)
      } else {
        editedByOthers.push(file)
      }
    }
  } catch {
    editedByOthers = files
  }

  return { editedByUs, editedByOthers }
}

function getSessionEditFilePath(edit: unknown): string | null {
  if (!edit || typeof edit !== "object") return null
  const filePath = Reflect.get(edit, "file_path")
  return typeof filePath === "string" ? filePath : null
}

async function appendUncommittedFileContext(
  gitLine: string,
  cwd: string,
  sessionId: string | undefined,
  gitStatus: GitStatus
): Promise<string> {
  if (gitStatus.total <= 0 || !gitStatus.lines || gitStatus.lines.length === 0) return gitLine

  const maxFiles = 30
  const { editedByUs, editedByOthers } = await classifySessionFiles(cwd, sessionId, gitStatus.lines)
  const sections = ["Uncommitted files:"]

  if (editedByUs.length > 0) {
    const visibleUs = editedByUs.slice(0, maxFiles)
    sections.push("  Edited in this session (by us):", ...visibleUs.map((file) => `    - ${file}`))
    if (editedByUs.length > maxFiles) {
      sections.push(`    ... and ${editedByUs.length - maxFiles} more file(s)`)
    }
  }

  if (editedByOthers.length > 0) {
    const remainingSlots = Math.max(5, maxFiles - editedByUs.length)
    const visibleOthers = editedByOthers.slice(0, remainingSlots)
    sections.push(
      "  Edited externally (by tools or other parallel agents):",
      ...visibleOthers.map((file) => `    - ${file}`)
    )
    if (editedByOthers.length > remainingSlots) {
      sections.push(`    ... and ${editedByOthers.length - remainingSlots} more file(s)`)
    }
  }

  return `${gitLine}\n${sections.join("\n")}`
}

async function buildStopGitSummary(
  cwd: string,
  sessionId: string | undefined,
  gitStatus: GitStatus,
  upstream: string,
  effective: Awaited<ReturnType<typeof resolveEffectiveSettings>>
): Promise<string> {
  const constructiveSummary = buildConstructiveGitSummary(gitStatus, upstream)
  const unpushedCommitSummaries = await getVisibleUnpushedCommitSummaries(cwd, gitStatus)
  let gitLine = buildGitContextLine(
    gitStatus,
    {
      collaborationMode: effective.collaborationMode,
      trunkMode: effective.trunkMode,
      strictNoDirectMain: effective.strictNoDirectMain,
      defaultBranch: effective.defaultBranch,
    },
    unpushedCommitSummaries
  )
  gitLine = await appendUncommittedFileContext(gitLine, cwd, sessionId, gitStatus)

  return [constructiveSummary, "Git context:", gitLine].filter(Boolean).join("\n\n")
}

/**
 * Determine if git status warrants stop hook evaluation.
 */
function gitStatusWarrantsStopHook(gitStatus: GitStatus): boolean {
  const { total, ahead, behind } = gitStatus
  if (total > 0) return true
  return ahead > 0 || behind > 0
}

/**
 * Resolve git context and collaboration settings.
 * Returns null (fail-open) if not a git repo or if status doesn't warrant checking.
 */
export async function resolveGitContext(input: StopHookInput): Promise<GitContext | null> {
  const cwd = input.cwd ?? process.cwd()
  if (!(await isGitRepo(cwd))) return null

  const effective = await resolveEffectiveSettings(input, cwd)

  const [gitStatus, remoteUrl] = await Promise.all([
    getGitStatusV2(cwd),
    git(["remote", "get-url", "origin"], cwd),
  ])

  if (!gitStatus || !gitStatusWarrantsStopHook(gitStatus)) return null

  const { branch } = gitStatus
  const hasUncommitted = gitStatus.total > 0
  const defaultBranch = await getDefaultBranch(cwd)
  const trunkMode = effective.trunkMode
  const upstream = gitStatus.upstream ?? `origin/${branch}`
  const summary = await buildStopGitSummary(
    cwd,
    input.session_id,
    gitStatus as GitStatus,
    upstream,
    effective
  )

  return {
    cwd,
    sessionId: input.session_id,
    gitStatus: gitStatus as GitStatus,
    summary,
    hasUncommitted,
    hasRemote: !!remoteUrl,
    upstream,
    collabMode: effective.collaborationMode,
    pushCooldownMinutes: effective.pushCooldownMinutes,
    defaultBranch,
    trunkMode,
  }
}
