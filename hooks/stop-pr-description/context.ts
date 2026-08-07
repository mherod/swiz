/**
 * Context resolution for PR description validation.
 *
 * Fetches PR data from GitHub. Returns null if prerequisite (open PR on feature branch) is missing.
 */

import { isGitRepoForHookPayload } from "../../src/repository-capability.ts"
import type { StopHookInput } from "../../src/schemas.ts"
import {
  getDefaultBranch,
  getOpenPrForBranch,
  git,
  hasGhCli,
  isDefaultBranch,
  isGitHubRemote,
} from "../../src/utils/hook-utils.ts"
import type { PRCheckContext } from "./types.ts"

export async function resolvePRCheckContext(input: StopHookInput): Promise<PRCheckContext | null> {
  const cwd = input.cwd ?? process.cwd()

  if (!(await isGitRepoForHookPayload(input, cwd))) return null
  if (!hasGhCli()) return null
  if (!(await isGitHubRemote(cwd))) return null

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return null

  const defaultBranch = await getDefaultBranch(cwd)
  if (isDefaultBranch(branch, defaultBranch)) return null

  const pr = await getOpenPrForBranch<{ number: number; title: string; body: string }>(
    branch,
    cwd,
    "number,title,body"
  )
  if (!pr) return null

  return {
    cwd,
    prNumber: pr.number,
    prTitle: pr.title,
    prBody: pr.body ?? "",
  }
}
