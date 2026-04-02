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

async function fetchGhPrMergeCreatedAt(
  prNumber: string | null,
  cwd: string
): Promise<string | null> {
  const repo = await getRepoSlug(cwd)
  if (!repo) return null

  if (prNumber) {
    const cached = await getIssueStoreReader().getPullRequest<{ createdAt: string }>(
      repo,
      parseInt(prNumber, 10)
    )
    if (cached?.createdAt) return cached.createdAt
  }

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
  if (pr) {
    getIssueStore().upsertPullRequests(repo, [pr])
  }
  return pr?.createdAt ?? null
}

async function evaluateGhPrMerge(
  command: string,
  cwd: string,
  gracePeriodMs: number,
  graceMinutes: number
): Promise<SwizHookOutput | null> {
  const prNumber = extractPrNumber(command)
  const createdAtStr = await fetchGhPrMergeCreatedAt(prNumber, cwd)
  if (!createdAtStr) return {}
  return checkPrAge(createdAtStr, gracePeriodMs, graceMinutes)
}

async function checkGitMergeBranch(command: string, cwd: string): Promise<string | null> {
  const branch = extractMergeBranch(command)
  if (!branch) return null

  const branchName = branch.replace(/^origin\//, "")

  const currentBranch = await git(["branch", "--show-current"], cwd)
  const defaultBranch = await getDefaultBranch(cwd)
  if (branchName === defaultBranch || branchName === currentBranch) return null
  return branchName
}

async function fetchGitMergePrCreatedAt(branchName: string, cwd: string): Promise<string | null> {
  const branchRepo = await getRepoSlug(cwd)
  if (!branchRepo) return null

  const stored = await getIssueStoreReader().listPullRequests<{
    number: number
    headRefName: string
    createdAt: string
  }>(branchRepo)
  const cached = stored.find((p) => p.headRefName === branchName)
  if (cached?.createdAt) return cached.createdAt

  const pr = await getOpenPrForBranch<{ number: number; createdAt: string }>(
    branchName,
    cwd,
    "number,title,state,headRefName,author,reviewDecision,mergeable,url,createdAt,updatedAt"
  )
  if (pr) {
    getIssueStore().upsertPullRequests(branchRepo, [pr])
  }
  return pr?.createdAt ?? null
}

async function evaluateGitMerge(
  command: string,
  cwd: string,
  gracePeriodMs: number,
  graceMinutes: number
): Promise<SwizHookOutput | null> {
  const branchName = await checkGitMergeBranch(command, cwd)
  if (!branchName) return {}

  const prCreatedAt = await fetchGitMergePrCreatedAt(branchName, cwd)
  if (!prCreatedAt) return {}

  return checkPrAge(prCreatedAt, gracePeriodMs, graceMinutes)
}

function parseCommandAndCwd(input: unknown): { command: string; cwd: string } | null {
  const parsed = toolHookInputSchema.parse(input)
  if (!isShellTool(parsed.tool_name ?? "")) return null

  const toolInput = (parsed.tool_input ?? {}) as Record<string, any>
  const command: string = String(toolInput.command ?? "")
  const cwd: string = (toolInput.cwd as string) ?? parsed.cwd ?? process.cwd()

  return { command, cwd }
}

export async function evaluatePretoolusePrAgeGate(input: unknown): Promise<SwizHookOutput> {
  const parsed = parseCommandAndCwd(input)
  if (!parsed) return {}
  const { command, cwd } = parsed

  const isGhPrMerge = GH_PR_MERGE_RE.test(command)
  const isGitMerge = GIT_MERGE_RE.test(command)

  if (!isGhPrMerge && !isGitMerge) return {}

  const settings = await readSwizSettings()
  const graceMinutes = settings.prAgeGateMinutes
  if (graceMinutes <= 0) return {}
  const gracePeriodMs = graceMinutes * 60 * 1000

  if (isGhPrMerge) {
    const result = await evaluateGhPrMerge(command, cwd, gracePeriodMs, graceMinutes)
    if (result) return result
  } else if (isGitMerge) {
    const result = await evaluateGitMerge(command, cwd, gracePeriodMs, graceMinutes)
    if (result) return result
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
