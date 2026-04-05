/**
 * GitHub PR state validator.
 *
 * Checks if current branch has an open PR with merge conflicts (GitHub mergeable=CONFLICTING).
 */

import { ghJson, hasGhCli } from "../../src/utils/hook-utils.ts"
import type { BranchCheckContext, GitHubPRState } from "./types.ts"

export async function getGitHubPRState(ctx: BranchCheckContext): Promise<GitHubPRState | null> {
  if (!hasGhCli()) return null

  const pr = await ghJson<{
    state: string
    mergeable: string
    mergeStateStatus: string
    number: number
    url: string
  }>(["pr", "view", ctx.branch, "--json", "mergeable,mergeStateStatus,state,number,url"], ctx.cwd)

  if (!pr) return null

  return {
    number: pr.number,
    url: pr.url,
    state: pr.state,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
  }
}

export function isPRConflicting(pr: GitHubPRState | null): boolean {
  return pr?.state === "OPEN" && pr?.mergeable === "CONFLICTING"
}

export function isPRMergeable(pr: GitHubPRState | null): boolean {
  return pr?.state === "OPEN" && pr?.mergeable === "MERGEABLE"
}
