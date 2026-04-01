#!/usr/bin/env bun

// PreToolUse hook: Enforce a minimum visibility period before PR merges.
//
// Detects two merge vectors:
//   1. `gh pr merge` — the standard GitHub CLI merge command
//   2. `git merge <branch>` — raw git merge that could bypass the PR workflow
//
// For both, fetches the PR's createdAt timestamp. If the PR has been open for
// less than the configured grace period (10 minutes), the merge is blocked with
// a message directing the agent to work on other tasks.
//
// Rationale: gives team members time to review or raise concerns before a PR
// is merged, preventing premature merges that bypass team visibility.
//
// Dual-mode: SwizToolHook + runSwizHookAsMain.

import { getIssueStore, getIssueStoreReader } from "../src/issue-store.ts"
import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHookOutput,
  type SwizToolHook,
} from "../src/SwizHook.ts"
import { readSwizSettings } from "../src/settings.ts"
import {
  extractMergeBranch,
  extractPrNumber,
  GH_PR_MERGE_RE,
  GIT_MERGE_RE,
  getDefaultBranch,
  getOpenPrForBranch,
  getRepoSlug,
  ghJson,
  git,
  isShellTool,
} from "../src/utils/hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

/** Format milliseconds as "Xm Ys". */
export function formatRemaining(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s`
  return `${minutes}m ${seconds}s`
}

function buildMergeBlockReason(remaining: string, graceMinutes: number): string {
  return (
    `BLOCKED: PR is in its visibility grace period (${remaining} remaining).\n\n` +
    `PRs must be open for at least ${graceMinutes} minutes before merging to give ` +
    `team members time to review or raise concerns.\n\n` +
    `Do not wait or retry — move on to your next task or issue. ` +
    `The merge will be allowed after the grace period expires.`
  )
}

function checkPrAge(
  createdAtStr: string,
  gracePeriodMs: number,
  graceMinutes: number
): SwizHookOutput | null {
  const createdAt = new Date(createdAtStr).getTime()
  if (Number.isNaN(createdAt)) return null

  const elapsed = Date.now() - createdAt

  if (elapsed < gracePeriodMs) {
    const remaining = formatRemaining(gracePeriodMs - elapsed)
    return preToolUseDeny(buildMergeBlockReason(remaining, graceMinutes))
  }
  return null
}

export async function evaluatePretoolusePrAgeGate(input: unknown): Promise<SwizHookOutput> {
  const parsed = toolHookInputSchema.parse(input)
  if (!isShellTool(parsed.tool_name ?? "")) return {}

  const toolInput = (parsed.tool_input ?? {}) as Record<string, any>
  const command: string = String(toolInput.command ?? "")

  const isGhPrMerge = GH_PR_MERGE_RE.test(command)
  const isGitMerge = GIT_MERGE_RE.test(command)

  if (!isGhPrMerge && !isGitMerge) return {}

  const settings = await readSwizSettings()
  const graceMinutes = settings.prAgeGateMinutes
  if (graceMinutes <= 0) return {}
  const gracePeriodMs = graceMinutes * 60 * 1000

  const cwd: string = (toolInput.cwd as string) ?? parsed.cwd ?? process.cwd()

  if (isGhPrMerge) {
    const prNumber = extractPrNumber(command)
    const repo = await getRepoSlug(cwd)
    let createdAtStr: string | null = null

    if (prNumber && repo) {
      const cached = await getIssueStoreReader().getPullRequest<{ createdAt: string }>(
        repo,
        parseInt(prNumber, 10)
      )
      createdAtStr = cached?.createdAt ?? null
    }

    if (!createdAtStr) {
      const viewArgs = prNumber
        ? [
            "pr",
            "view",
            prNumber,
            "--json",
            "number,title,state,headRefName,author,reviewDecision,mergeable,url,createdAt,updatedAt",
          ]
        : [
            "pr",
            "view",
            "--json",
            "number,title,state,headRefName,author,reviewDecision,mergeable,url,createdAt,updatedAt",
          ]
      const pr = await ghJson<{ number: number; createdAt: string }>(viewArgs, cwd)
      if (pr && repo) {
        getIssueStore().upsertPullRequests(repo, [pr])
      }
      createdAtStr = pr?.createdAt ?? null
    }

    if (!createdAtStr) return {}
    const blocked = checkPrAge(createdAtStr, gracePeriodMs, graceMinutes)
    if (blocked) return blocked
  } else if (isGitMerge) {
    const branch = extractMergeBranch(command)
    if (!branch) return {}

    const branchName = branch.replace(/^origin\//, "")

    const currentBranch = await git(["branch", "--show-current"], cwd)
    const defaultBranch = await getDefaultBranch(cwd)
    if (branchName === defaultBranch) return {}
    if (branchName === currentBranch) return {}

    let prCreatedAt: string | null = null
    const branchRepo = await getRepoSlug(cwd)
    if (branchRepo) {
      const stored = await getIssueStoreReader().listPullRequests<{
        number: number
        headRefName: string
        createdAt: string
      }>(branchRepo)
      prCreatedAt = stored.find((p) => p.headRefName === branchName)?.createdAt ?? null
    }

    if (!prCreatedAt) {
      const pr = await getOpenPrForBranch<{ number: number; createdAt: string }>(
        branchName,
        cwd,
        "number,title,state,headRefName,author,reviewDecision,mergeable,url,createdAt,updatedAt"
      )
      if (pr && branchRepo) {
        getIssueStore().upsertPullRequests(branchRepo, [pr])
      }
      prCreatedAt = pr?.createdAt ?? null
    }

    if (!prCreatedAt) return {}
    const blocked = checkPrAge(prCreatedAt, gracePeriodMs, graceMinutes)
    if (blocked) return blocked
  }

  return preToolUseAllow("PR age grace period has elapsed — merge allowed")
}

const pretoolusePrAgeGate: SwizToolHook = {
  name: "pretooluse-pr-age-gate",
  event: "preToolUse",
  timeout: 10,

  run(input) {
    return evaluatePretoolusePrAgeGate(input)
  },
}

export default pretoolusePrAgeGate

if (import.meta.main) {
  await runSwizHookAsMain(pretoolusePrAgeGate)
}
