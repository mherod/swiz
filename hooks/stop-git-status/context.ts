/**
 * Context resolution for stop-git-status validator.
 *
 * Loads git state, collaboration settings, and determines scope.
 * Returns null (fail-open) if prerequisites not met.
 */

import { git } from "../../src/git-helpers.ts"
import { isGitRepoForHookPayload } from "../../src/repository-capability.ts"
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
import {
  getDefaultBranch,
  getGitStatusV2,
  getUnpushedCommitSummaries,
} from "../../src/utils/git-utils.ts"
import {
  appendSessionFileOwnershipContext,
  resolveSessionFileOwnership,
  type SessionFileOwnership,
} from "../../src/utils/session-file-ownership.ts"
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

function appendUncommittedFileContext(
  gitLine: string,
  ownership: SessionFileOwnership | null
): string {
  if (!ownership) return gitLine
  return appendSessionFileOwnershipContext(gitLine, ownership)
}

async function buildStopGitSummary(
  cwd: string,
  ownership: SessionFileOwnership | null,
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
  gitLine = appendUncommittedFileContext(gitLine, ownership)

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
  if (!(await isGitRepoForHookPayload(input, cwd))) return null

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
  // Resolved once here so both the prose summary and the action plan see the
  // same ownership snapshot — the plan previously ignored it (issue #841).
  const ownership =
    hasUncommitted && gitStatus.lines && gitStatus.lines.length > 0
      ? await resolveSessionFileOwnership(cwd, input.session_id, gitStatus.lines)
      : null
  const summary = await buildStopGitSummary(
    cwd,
    ownership,
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
    ownership,
  }
}
