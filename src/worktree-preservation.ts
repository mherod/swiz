import { isAbsolute, resolve } from "node:path"
import { git, isDefaultBranch } from "./git-helpers.ts"

export type WorktreePreservationReason =
  | "default-branch"
  | "trunk-mode"
  | "not-linked-worktree"
  | "default-ref-unavailable"
  | "merge-base-unavailable"
  | "no-conflicts"

export type WorktreePreservationDecision =
  | {
      preserveViaPr: true
      branch: string
      defaultBranch: string
      defaultRef: string
      conflictCount: number | null
    }
  | {
      preserveViaPr: false
      branch: string
      defaultBranch: string
      reason: WorktreePreservationReason
    }

export interface WorktreePreservationInput {
  cwd: string
  branch: string
  defaultBranch: string
  trunkMode: boolean
  /** GitHub's CONFLICTING state can authoritatively establish the conflict. */
  conflictsWithDefault?: true
}

export interface WorktreePreservationRuntime {
  git(args: string[], cwd: string): Promise<string>
}

const defaultRuntime: WorktreePreservationRuntime = { git }

function absoluteGitPath(cwd: string, path: string): string {
  return resolve(cwd, path)
}

async function getAbsoluteCommonGitDir(
  cwd: string,
  runtime: WorktreePreservationRuntime
): Promise<string> {
  const absolute = await runtime.git(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd
  )
  if (absolute) return absoluteGitPath(cwd, absolute)

  const fallback = await runtime.git(["rev-parse", "--git-common-dir"], cwd)
  if (!fallback) return ""
  return isAbsolute(fallback) ? resolve(fallback) : resolve(cwd, fallback)
}

export async function isLinkedGitWorktree(
  cwd: string,
  runtime: WorktreePreservationRuntime = defaultRuntime
): Promise<boolean> {
  const [gitDir, commonGitDir] = await Promise.all([
    runtime.git(["rev-parse", "--absolute-git-dir"], cwd),
    getAbsoluteCommonGitDir(cwd, runtime),
  ])
  if (!gitDir || !commonGitDir) return false
  return absoluteGitPath(cwd, gitDir) !== commonGitDir
}

async function resolveDefaultRef(
  cwd: string,
  defaultBranch: string,
  runtime: WorktreePreservationRuntime
): Promise<string> {
  for (const candidate of [`upstream/${defaultBranch}`, `origin/${defaultBranch}`, defaultBranch]) {
    if (await runtime.git(["rev-parse", "--verify", candidate], cwd)) return candidate
  }
  return ""
}

export function countMergeTreeConflicts(mergeTree: string): number {
  const markerCount = (mergeTree.match(/^\+?<{7}(?: |$)/gm) ?? []).length
  const noticeCount = (mergeTree.match(/^CONFLICT \(/gm) ?? []).length
  return Math.max(markerCount, noticeCount)
}

async function countMergeConflicts(
  cwd: string,
  defaultRef: string,
  runtime: WorktreePreservationRuntime
): Promise<number | null> {
  const mergeBase = await runtime.git(["merge-base", "HEAD", defaultRef], cwd)
  if (!mergeBase) return null

  const mergeTree = await runtime.git(["merge-tree", mergeBase, "HEAD", defaultRef], cwd)
  return countMergeTreeConflicts(mergeTree)
}

/**
 * Decide whether a linked worktree must be preserved through a pull request.
 * Every non-preservation result deliberately leaves the existing branch policy intact.
 */
export async function evaluateWorktreePreservation(
  input: WorktreePreservationInput,
  runtime: WorktreePreservationRuntime = defaultRuntime
): Promise<WorktreePreservationDecision> {
  const normal = (reason: WorktreePreservationReason): WorktreePreservationDecision => ({
    preserveViaPr: false,
    branch: input.branch,
    defaultBranch: input.defaultBranch,
    reason,
  })

  if (isDefaultBranch(input.branch, input.defaultBranch)) return normal("default-branch")
  if (input.trunkMode) return normal("trunk-mode")
  if (!(await isLinkedGitWorktree(input.cwd, runtime))) return normal("not-linked-worktree")

  const defaultRef = await resolveDefaultRef(input.cwd, input.defaultBranch, runtime)
  if (input.conflictsWithDefault) {
    return {
      preserveViaPr: true,
      branch: input.branch,
      defaultBranch: input.defaultBranch,
      defaultRef: defaultRef || input.defaultBranch,
      conflictCount: null,
    }
  }
  if (!defaultRef) return normal("default-ref-unavailable")

  const conflictCount = await countMergeConflicts(input.cwd, defaultRef, runtime)
  if (conflictCount === null) return normal("merge-base-unavailable")
  if (conflictCount === 0) return normal("no-conflicts")

  return {
    preserveViaPr: true,
    branch: input.branch,
    defaultBranch: input.defaultBranch,
    defaultRef,
    conflictCount,
  }
}
