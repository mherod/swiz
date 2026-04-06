/**
 * Context resolution for stop-lockfile-drift validator.
 *
 * Loads git state, detects changed files, and determines scope.
 * Returns null (fail-open) if prerequisites not met.
 */

import type { StopHookInput } from "../../src/schemas.ts"
import { git, isGitRepo, recentHeadRange } from "../../src/utils/hook-utils.ts"
import type { LockfileDriftContext } from "./types.ts"

/**
 * Resolve git context and changed files for drift detection.
 * Returns null if not a git repo or if no git range found.
 */
export async function resolveLockfileDriftContext(
  input: StopHookInput
): Promise<LockfileDriftContext | null> {
  const cwd = input.cwd ?? process.cwd()
  const sessionId = input.session_id ?? null

  // Fail-open: not a git repo
  if (!(await isGitRepo(cwd))) return null

  // Resolve recent commit range
  const range = await recentHeadRange(cwd, 10)
  if (!range) return null

  // Get changed files
  const changedRaw = await git(["diff", "--name-only", range], cwd)
  if (!changedRaw) return null

  const changedFiles = new Set(changedRaw.split("\n").filter((l) => l.trim()))

  return {
    cwd,
    sessionId,
    range,
    changedFiles,
  }
}
