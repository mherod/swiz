import { detectRepoOwnership } from "../../src/collaboration-policy.ts"
import { isGitRepoForHookPayload } from "../../src/repository-capability.ts"
import { readProjectSettings } from "../../src/settings.ts"
import {
  getDefaultBranch,
  git,
  hasGhCli,
  isDefaultBranch,
  isGitHubRemote,
  sanitizeSessionId,
} from "../../src/utils/hook-utils.ts"
import { evaluateWorktreePreservation } from "../../src/worktree-preservation.ts"
import { getOpenPRsWithFeedback, partitionPRsForStop } from "./pull-requests.ts"
import type { PR, RepoContext, StopContext } from "./types.ts"

export async function resolveRepoContext(input: {
  cwd?: string
  session_id?: string
}): Promise<RepoContext | null> {
  const cwd = input.cwd
  if (!cwd) return null // fail open: cwd is required for repo detection
  const sessionId = sanitizeSessionId(input.session_id)

  if (!(await isGitRepoForHookPayload(input, cwd))) return null
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

export function buildStopContext(
  ctx: RepoContext,
  prs: PR[],
  preservedConflictPrNumbers: ReadonlySet<number> = new Set()
): StopContext | null {
  const { changesRequestedPRs, reviewRequiredPRs, conflictingPRs } = partitionPRsForStop(
    prs,
    preservedConflictPrNumbers
  )

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

export async function getPreservedConflictPrNumbers(
  cwd: string,
  prs: PR[]
): Promise<ReadonlySet<number>> {
  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return new Set()

  const candidates = prs.filter((pr) => pr.mergeable === "CONFLICTING" && pr.headRefName === branch)
  if (candidates.length === 0) return new Set()

  const defaultBranch = await getDefaultBranch(cwd)
  const targetsDefault = candidates.filter(
    (pr) => !pr.baseRefName || isDefaultBranch(pr.baseRefName, defaultBranch)
  )
  if (targetsDefault.length === 0) return new Set()

  const trunkMode = (await readProjectSettings(cwd))?.trunkMode === true
  const decision = await evaluateWorktreePreservation({
    cwd,
    branch,
    defaultBranch,
    trunkMode,
    conflictsWithDefault: true,
  })
  if (!decision.preserveViaPr) return new Set()

  return new Set(targetsDefault.map((pr) => pr.number))
}
