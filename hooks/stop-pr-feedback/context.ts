import { detectRepoOwnership } from "../../src/collaboration-policy.ts"
import {
  hasGhCli,
  isGitHubRemote,
  isGitRepo,
  sanitizeSessionId,
} from "../../src/utils/hook-utils.ts"
import { getOpenPRsWithFeedback, partitionPRsForStop } from "./pull-requests.ts"
import type { PR, RepoContext, StopContext } from "./types.ts"

export async function resolveRepoContext(input: {
  cwd?: string
  session_id?: string
}): Promise<RepoContext | null> {
  const cwd = input.cwd
  if (!cwd) return null // fail open: cwd is required for repo detection
  const sessionId = sanitizeSessionId(input.session_id)

  if (!(await isGitRepo(cwd))) return null
  if (!hasGhCli()) return null

  const hasRemote = await isGitHubRemote(cwd)
  if (!hasRemote) return null

  const ownership = await detectRepoOwnership(cwd)
  if (!ownership.repoOwner || !ownership.currentUser) return null

  return {
    cwd,
    sessionId,
    rawSessionId: input.session_id,
    currentUser: ownership.currentUser,
    isPersonalRepo: ownership.isPersonalRepo,
  }
}

export function buildStopContext(ctx: RepoContext, prs: PR[]): StopContext | null {
  const { changesRequestedPRs, reviewRequiredPRs, conflictingPRs } = partitionPRsForStop(prs)

  const total = changesRequestedPRs.length + reviewRequiredPRs.length + conflictingPRs.length
  if (total === 0) return null

  return {
    cwd: ctx.cwd,
    sessionId: ctx.sessionId,
    isPersonalRepo: ctx.isPersonalRepo,
    changesRequestedPRs,
    reviewRequiredPRs,
    conflictingPRs,
  }
}

export async function gatherPRFeedback(cwd: string, currentUser: string): Promise<PR[]> {
  return await getOpenPRsWithFeedback(cwd, currentUser)
}
