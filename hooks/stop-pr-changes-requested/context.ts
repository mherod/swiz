/**
 * Context resolution for stop-pr-changes-requested hook.
 *
 * Collects PR metadata and settings with fail-open on missing prerequisites.
 */

import { getCollaborationModePolicy } from "../../src/collaboration-policy.ts"
import type { StopHookInput } from "../../src/schemas.ts"
import {
  getEffectiveSwizSettings,
  readProjectSettings,
  readSwizSettings,
} from "../../src/settings.ts"
import {
  getCurrentGitHubUser,
  getDefaultBranch,
  getOpenPrForBranch,
  getRepoNameWithOwner,
  git,
  hasGhCli,
  isDefaultBranch,
  isGitHubRemote,
  isGitRepo,
} from "../../src/utils/hook-utils.ts"
import type { PRCheckContext } from "./types.ts"

export async function resolvePRCheckContext(input: StopHookInput): Promise<PRCheckContext | null> {
  const cwd = input.cwd ?? process.cwd()

  // Load and validate settings
  const [globalSettings, projectSettings] = await Promise.all([
    readSwizSettings(),
    readProjectSettings(cwd),
  ])
  const effective = getEffectiveSwizSettings(globalSettings, input.session_id, projectSettings)
  const modePolicy = getCollaborationModePolicy(effective.collaborationMode)

  // Fail open: if peer review not required, skip hook
  if (!modePolicy.requirePeerReview) return null

  // Fail open: prerequisites
  if (!(await isGitRepo(cwd))) return null
  if (!hasGhCli()) return null
  if (!(await isGitHubRemote(cwd))) return null

  // Resolve current branch, default branch, repo, and current user in parallel
  const [branch, defaultBranch, repo, currentUser] = await Promise.all([
    git(["branch", "--show-current"], cwd),
    getDefaultBranch(cwd),
    getRepoNameWithOwner(cwd),
    getCurrentGitHubUser(cwd),
  ])

  // Fail open: missing critical data
  if (!branch) return null
  if (isDefaultBranch(branch, defaultBranch)) return null
  if (!repo) return null

  // Resolve open PR for current branch
  const pr = await getOpenPrForBranch<{
    number: number
    title: string
    author?: { login?: string }
  }>(branch, cwd, "number,title,author")

  if (!pr) return null

  return { cwd, sessionId: input.session_id, pr, repo, currentUser }
}
