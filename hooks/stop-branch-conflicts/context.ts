/**
 * Context resolution for branch conflict detection.
 *
 * Resolves prerequisites: git repo, current branch, default branch, fork topology.
 * Returns null if any prerequisite is missing (fail-open).
 */

import type { StopHookInput } from "../../src/schemas.ts"
import {
  detectForkTopology,
  forkRemoteRef,
  getDefaultBranch,
  git,
  isDefaultBranch,
  isGitRepo,
} from "../../src/utils/hook-utils.ts"
import type { BranchCheckContext } from "./types.ts"

export async function resolveBranchCheckContext(
  input: StopHookInput
): Promise<BranchCheckContext | null> {
  const cwd = input.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return null

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return null

  const defaultBranch = await getDefaultBranch(cwd)
  if (isDefaultBranch(branch, defaultBranch)) return null

  const fork = await detectForkTopology(cwd)
  if (!fork) return null

  const defaultRemoteRef = forkRemoteRef(defaultBranch, fork)

  return {
    cwd,
    branch,
    defaultBranch,
    defaultRemoteRef,
    forkTopology: fork,
  }
}
