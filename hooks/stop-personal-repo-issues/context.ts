import { detectRepoOwnership } from "../../src/collaboration-policy.ts"
import { needsRefinement } from "../../src/issue-refinement.ts"
import type { ProjectState } from "../../src/settings.ts"
import {
  hasGhCli,
  isGitHubRemote,
  isGitRepo,
  sanitizeSessionId,
} from "../../src/utils/hook-utils.ts"
import { isInCooldown } from "./cooldown.ts"
import {
  filterBlockedIssues,
  filterVisibleIssues,
  getAllOpenIssues,
  sortIssuesByScoreAndNumber,
} from "./issues.ts"
import type { Issue, RepoContext, StopContext } from "./types.ts"

/** Matches cooldown update in main: refinement-only blocks do not refresh cooldown. */
export function shouldUpdateStopCooldown(ctx: StopContext): boolean {
  return ctx.sortedIssues.length > 0
}

export async function gatherStopContext(
  cwd: string,
  isPersonalRepo: boolean,
  currentUser: string,
  hasChangesRequested: boolean,
  allOpenPRIssueNumbers: Set<number>
): Promise<{
  sortedRefinement: Issue[]
  sortedIssues: Issue[]
  blockedIssues: Issue[]
  firstRefinementNum?: number
  firstIssueNum?: number
}> {
  if (hasChangesRequested) {
    return { sortedRefinement: [], sortedIssues: [], blockedIssues: [] }
  }

  const { issues: rawIssues, repoSlug } = await getAllOpenIssues(cwd)
  const filterUser = isPersonalRepo ? undefined : currentUser
  const actionable = filterVisibleIssues(rawIssues, filterUser)

  const refinementIssues = actionable.filter((i) => needsRefinement(i))
  // Prefer issues that do not already have an open PR representing started work
  const allReadyIssues = actionable.filter((i) => !needsRefinement(i))
  const readyWithoutPR = allReadyIssues.filter((i) => !allOpenPRIssueNumbers.has(i.number))
  const readyIssues = readyWithoutPR.length > 0 ? readyWithoutPR : allReadyIssues

  const sortedRefinement = sortIssuesByScoreAndNumber(refinementIssues)
  const sortedIssues = sortIssuesByScoreAndNumber(readyIssues)

  // Only surface blocked issues when there are no ready issues to work on
  const blockedIssues =
    sortedIssues.length === 0
      ? sortIssuesByScoreAndNumber(filterBlockedIssues(rawIssues, repoSlug ?? "", filterUser))
      : []

  return {
    sortedRefinement,
    sortedIssues,
    blockedIssues,
    firstRefinementNum: sortedRefinement[0]?.number,
    firstIssueNum: sortedIssues[0]?.number,
  }
}

export async function resolveRepoContext(input: {
  cwd?: string
  session_id?: string
}): Promise<RepoContext | null> {
  const cwd = input.cwd
  if (!cwd) return null // fail open: cwd is required for repo detection
  const sessionId = sanitizeSessionId(input.session_id)

  if (!(await isGitRepo(cwd))) return null
  if (!hasGhCli()) return null

  const [hasRemote, inCooldown] = await Promise.all([
    isGitHubRemote(cwd),
    isInCooldown(sessionId, cwd),
  ])
  if (!hasRemote) return null
  if (inCooldown) return null

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
  gathered: Awaited<ReturnType<typeof gatherStopContext>>,
  projectState: ProjectState | null,
  strictNoDirectMain: boolean
): StopContext | null {
  const total =
    gathered.sortedIssues.length + gathered.sortedRefinement.length + gathered.blockedIssues.length
  if (total === 0) return null

  return {
    cwd: ctx.cwd,
    sessionId: ctx.sessionId,
    isPersonalRepo: ctx.isPersonalRepo,
    projectState,
    sortedRefinement: gathered.sortedRefinement,
    sortedIssues: gathered.sortedIssues,
    blockedIssues: gathered.blockedIssues,
    firstRefinementNum: gathered.sortedRefinement[0]?.number,
    firstIssueNum: gathered.sortedIssues[0]?.number,
    strictNoDirectMain,
  }
}
