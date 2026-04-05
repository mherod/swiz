/**
 * Branch conflict detection types.
 *
 * Domain types for branch sync validation.
 */

import type { ForkTopology } from "../../src/git-helpers.ts"

export interface BranchCheckContext {
  cwd: string
  branch: string
  defaultBranch: string
  defaultRemoteRef: string
  forkTopology: ForkTopology
}

export interface GitMergeState {
  conflictCount: number
  behindCount: number
}

export interface GitHubPRState {
  number: number
  url: string
  state: string
  mergeable: string
  mergeStateStatus: string
}
