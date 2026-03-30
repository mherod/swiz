#!/usr/bin/env bun
// Stop hook: Block stop if GitHub CI checks are pending or failing.
// When CI is in_progress, polls up to MAX_POLL_MS before blocking — avoids
// false-positive blocks for short CI runs that complete within seconds.
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import { getCollaborationModePolicy } from "../src/collaboration-policy.ts"
import { getIssueStore, getIssueStoreReader } from "../src/issue-store.ts"
import { runSwizHookAsMain } from "../src/RunSwizHookAsMain.ts"
import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { getEffectiveSwizSettings, readProjectSettings, readSwizSettings } from "../src/settings.ts"
import {
  type ActionPlanItem,
  blockStopObj,
  formatActionPlan,
  getDefaultBranch,
  getRepoSlug,
  ghJson,
  git,
  hasGhCli,
  isDefaultBranch,
  isGitHubRemote,
  isGitRepo,
  mergeActionPlanIntoTasks,
  skillExists,
} from "../src/utils/hook-utils.ts"
import { type StopHookInput, stopHookInputSchema } from "./schemas.ts"

const POLL_INTERVAL_MS = 5_000
const MAX_POLL_MS = 30_000

interface CIRun {
  databaseId?: number
  status: string
  conclusion: string
  workflowName: string
  createdAt: string
  event: string
}

const CI_RUN_FIELDS = "databaseId,status,conclusion,workflowName,createdAt,event"

async function fetchRuns(branch: string, cwd: string): Promise<CIRun[]> {
  const repo = await getRepoSlug(cwd)
  if (repo) {
    const cached = await getIssueStoreReader().getCiBranchRuns<CIRun>(repo, branch)
    if (cached) return cached.filter((r) => r.event !== "dynamic" && r.event !== "workflow_run")
  }

  const runs = await ghJson<CIRun[]>(
    ["run", "list", "--branch", branch, "--limit", "5", "--json", CI_RUN_FIELDS],
    cwd
  )
  const fresh = runs ?? []
  if (repo) {
    getIssueStore().upsertCiBranchRuns(repo, branch, fresh)
  }
  return fresh.filter((r) => r.event !== "dynamic" && r.event !== "workflow_run")
}

export function findActive(runs: CIRun[]): CIRun[] {
  return runs.filter((r) => r.status === "in_progress" || r.status === "queued")
}

export function findFailing(runs: CIRun[]): CIRun[] {
  const byWorkflow = new Map<string, CIRun>()
  for (const run of runs) {
    const existing = byWorkflow.get(run.workflowName)
    if (!existing || run.createdAt > existing.createdAt) {
      byWorkflow.set(run.workflowName, run)
    }
  }
  return [...byWorkflow.values()].filter(
    (r) =>
      r.status === "completed" &&
      (r.conclusion === "failure" ||
        r.conclusion === "timed_out" ||
        r.conclusion === "action_required")
  )
}

async function resolveTargetBranch(
  cwd: string,
  sessionId: string | undefined
): Promise<string | null> {
  if (!(await isGitRepo(cwd))) return null
  const [globalSettings, projectSettings] = await Promise.all([
    readSwizSettings(),
    readProjectSettings(cwd),
  ])
  const effective = getEffectiveSwizSettings(globalSettings, sessionId, projectSettings)
  const modePolicy = getCollaborationModePolicy(effective.collaborationMode)
  if (!modePolicy.requirePeerReview) return null
  if (!hasGhCli()) return null
  if (!(await isGitHubRemote(cwd))) return null
  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return null
  const defaultBranch = await getDefaultBranch(cwd)
  if (isDefaultBranch(branch, defaultBranch)) return null
  return branch
}

async function pollUntilComplete(branch: string, cwd: string): Promise<CIRun[]> {
  let relevant = await fetchRuns(branch, cwd)
  if (!relevant.length) return relevant
  if (findActive(relevant).length === 0) return relevant

  const deadline = Date.now() + MAX_POLL_MS
  while (Date.now() < deadline && findActive(relevant).length > 0) {
    await Bun.sleep(POLL_INTERVAL_MS)
    relevant = await fetchRuns(branch, cwd)
  }
  return relevant
}

interface CIBlockResult {
  reason: string
  planSteps: ActionPlanItem[]
}

function buildFailingResult(branch: string, failing: CIRun[]): CIBlockResult {
  const names = failing.map((r) => `${r.workflowName} (${r.conclusion})`).join(", ")
  let reason = `GitHub CI is failing on branch '${branch}'.\n\n`
  reason += `Failing checks (${failing.length}): ${names}\n\n`
  reason += "To view failure logs:\n"
  for (const r of failing)
    reason += r.databaseId
      ? `  gh run view ${r.databaseId} --log-failed\n`
      : `  gh run list --branch ${branch}\n`

  const fixSubSteps: ActionPlanItem[] = []
  if (skillExists("ci-status")) {
    fixSubSteps.push("/ci-status — Analyze failures and fix them")
  }
  fixSubSteps.push(
    "View failure details: gh run view <run-id> --log-failed",
    "Fix the failing code (type errors, test failures, lint issues)",
    "Run checks locally: bun run typecheck && bun run lint && bun test",
    "Commit and push the fix",
    "Wait for CI to go green: gh run watch <run-id> --exit-status"
  )
  const planSteps: ActionPlanItem[] = ["Analyze and fix CI failures before stopping:", fixSubSteps]
  reason += `\n${formatActionPlan(planSteps, { translateToolNames: true })}`
  return { reason, planSteps }
}

function buildActiveResult(branch: string, active: CIRun[]): CIBlockResult {
  const names = active.map((r) => `${r.workflowName} (${r.status})`).join(", ")
  let reason = `GitHub CI is still running on branch '${branch}' after waiting ${MAX_POLL_MS / 1000}s.\n\n`
  reason += `Active checks (${active.length}): ${names}\n\n`

  const waitSubSteps: ActionPlanItem[] = []
  if (skillExists("ci-status")) {
    waitSubSteps.push("/ci-status — Check results once CI completes")
  }
  waitSubSteps.push(
    `gh run list --branch ${branch}`,
    "gh run watch <run-id> --exit-status",
    "Once complete: if passing → stop. If failing → fix before stopping."
  )
  const planSteps: ActionPlanItem[] = ["Wait for CI to complete, then check results:", waitSubSteps]
  reason += formatActionPlan(planSteps, { translateToolNames: true })
  return { reason, planSteps }
}

export async function evaluateStopGithubCi(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  const cwd = parsed.cwd ?? process.cwd()

  const branch = await resolveTargetBranch(cwd, parsed.session_id)
  if (!branch) return {}

  const relevant = await pollUntilComplete(branch, cwd)
  if (!relevant.length) return {}

  const sessionId = parsed.session_id

  const failing = findFailing(relevant)
  if (failing.length > 0) {
    const { reason, planSteps } = buildFailingResult(branch, failing)
    if (sessionId) await mergeActionPlanIntoTasks(planSteps, sessionId, cwd)
    return blockStopObj(reason)
  }

  const stillActive = findActive(relevant)
  if (stillActive.length > 0) {
    const { reason, planSteps } = buildActiveResult(branch, stillActive)
    if (sessionId) await mergeActionPlanIntoTasks(planSteps, sessionId, cwd)
    return blockStopObj(reason)
  }
  return {}
}

const stopGithubCi: SwizStopHook = {
  name: "stop-github-ci",
  event: "stop",
  timeout: 45,
  requiredSettings: ["githubCiGate"],

  run(input) {
    return evaluateStopGithubCi(input)
  },
}

export default stopGithubCi

if (import.meta.main) {
  await runSwizHookAsMain(stopGithubCi)
}
