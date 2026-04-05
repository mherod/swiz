/**
 * Context resolution for stop-git-status validator.
 *
 * Loads git state, collaboration settings, and determines scope.
 * Returns null (fail-open) if prerequisites not met.
 */

import {
  type CollaborationMode,
  getEffectiveSwizSettings,
  readProjectSettings,
  readSwizSettings,
} from "../../src/settings.ts"
import { getDefaultBranch, getGitStatusV2, git, isGitRepo } from "../../src/utils/hook-utils.ts"
import type { StopHookInput } from "../schemas.ts"
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
}> {
  const projectSettings = await readProjectSettings(cwd)
  if (input._effectiveSettings && typeof input._effectiveSettings.collaborationMode === "string") {
    const injected = input._effectiveSettings as {
      collaborationMode: CollaborationMode
      pushCooldownMinutes?: number
    }
    return {
      collaborationMode: injected.collaborationMode,
      pushCooldownMinutes: injected.pushCooldownMinutes ?? 0,
      projectSettings,
    }
  }
  const settings = await readSwizSettings()
  const full = getEffectiveSwizSettings(settings, input.session_id, projectSettings)
  return {
    collaborationMode: full.collaborationMode,
    pushCooldownMinutes: full.pushCooldownMinutes,
    projectSettings,
  }
}

/**
 * Determine if git status warrants stop hook evaluation.
 */
function gitStatusWarrantsStopHook(gitStatus: GitStatus): boolean {
  const { branch, total, ahead, behind } = gitStatus
  if (!branch || branch === "(detached)") return false
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
  const trunkMode = effective.projectSettings?.trunkMode === true

  return {
    cwd,
    sessionId: input.session_id,
    gitStatus: gitStatus as GitStatus,
    hasUncommitted,
    hasRemote: !!remoteUrl,
    upstream: gitStatus.upstream ?? `origin/${branch}`,
    collabMode: effective.collaborationMode,
    pushCooldownMinutes: effective.pushCooldownMinutes,
    defaultBranch,
    trunkMode,
  }
}
