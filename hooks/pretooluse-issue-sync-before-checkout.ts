#!/usr/bin/env bun

/**
 * PreToolUse hook: runs `swiz issue sync` before any branch-switching
 * git command (checkout, switch) so the local issue store is fresh
 * when work begins on a new branch.
 *
 * Dual-mode: SwizToolHook + runSwizHookAsMain.
 */

import { getRepoSlug } from "../src/git-helpers.ts"
import { syncUpstreamState } from "../src/issue-store-sync.ts"
import { runSwizHookAsMain, type SwizHookOutput, type SwizToolHook } from "../src/SwizHook.ts"
import { shellHookInputSchema } from "../src/schemas.ts"
import {
  collectCheckoutNewBranchNames,
  collectPlainCheckoutSwitchTargets,
} from "../src/utils/git-utils.ts"
import {
  GIT_CHECKOUT_RE,
  GIT_SWITCH_RE,
  isShellTool,
  preToolUseAllowWithContext,
} from "../src/utils/hook-utils.ts"

function isBranchSwitchCommand(command: string): boolean {
  if (!GIT_CHECKOUT_RE.test(command) && !GIT_SWITCH_RE.test(command)) return false
  const targets = [
    ...collectPlainCheckoutSwitchTargets(command),
    ...collectCheckoutNewBranchNames(command),
  ]
  return targets.length > 0
}

function buildSyncMessage(
  result: Awaited<ReturnType<typeof syncUpstreamState>>,
  repo: string
): string {
  const totalChanges =
    result.issues.changes.length +
    result.pullRequests.changes.length +
    result.ciStatuses.changes.length +
    result.labels.changes.length +
    result.milestones.changes.length
  return totalChanges > 0
    ? `Issue sync completed before branch switch (${totalChanges} change${totalChanges === 1 ? "" : "s"} synced for ${repo}).`
    : `Issue sync completed before branch switch (${repo} already up to date).`
}

type RepoSlugResolver = (cwd: string) => Promise<string | null>

async function runSync(
  cwd: string,
  syncFn: typeof syncUpstreamState,
  repoSlugResolver: RepoSlugResolver
): Promise<SwizHookOutput> {
  const repo = await repoSlugResolver(cwd)
  if (!repo) return {}
  try {
    const result = await syncFn(repo, cwd)
    return preToolUseAllowWithContext("", buildSyncMessage(result, repo))
  } catch {
    return {}
  }
}

export async function evaluateIssueSyncBeforeCheckout(
  input: unknown,
  syncFn: typeof syncUpstreamState = syncUpstreamState,
  repoSlugResolver: RepoSlugResolver = getRepoSlug
): Promise<SwizHookOutput> {
  const hookInput = shellHookInputSchema.parse(input)
  const cwd: string = hookInput.cwd ?? process.cwd()
  const command = String(hookInput.tool_input?.command ?? "")

  if (!isShellTool(hookInput.tool_name ?? "")) return {}
  if (!isBranchSwitchCommand(command)) return {}

  return await runSync(cwd, syncFn, repoSlugResolver)
}

const pretooluseIssueSyncBeforeCheckout: SwizToolHook = {
  name: "pretooluse-issue-sync-before-checkout",
  event: "preToolUse",
  timeout: 30,
  async: true,
  run(input) {
    return evaluateIssueSyncBeforeCheckout(input)
  },
}

export default pretooluseIssueSyncBeforeCheckout

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseIssueSyncBeforeCheckout)
}
