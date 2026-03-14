#!/usr/bin/env bun
// Stop hook: Block stop if GitHub CI checks are pending or failing.
// When CI is in_progress, polls up to MAX_POLL_MS before blocking — avoids
// false-positive blocks for short CI runs that complete within seconds.

import { getCollaborationModePolicy } from "../src/collaboration-policy.ts"
import { getIssueStore } from "../src/issue-store.ts"
import { getEffectiveSwizSettings, readProjectSettings, readSwizSettings } from "../src/settings.ts"
import {
  blockStop,
  getDefaultBranch,
  getRepoSlug,
  ghJson,
  git,
  hasGhCli,
  isDefaultBranch,
  isGitHubRemote,
  isGitRepo,
  skillAdvice,
} from "./hook-utils.ts"
import { stopHookInputSchema } from "./schemas.ts"

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
    const cached = getIssueStore().getCiBranchRuns<CIRun>(repo, branch)
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
  if (!effective.githubCiGate) return null
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

function buildFailingReason(branch: string, failing: CIRun[]): string {
  const names = failing.map((r) => `${r.workflowName} (${r.conclusion})`).join(", ")
  let reason = `GitHub CI is failing on branch '${branch}'.\n\n`
  reason += `Failing checks (${failing.length}): ${names}\n\n`
  reason += "To view failure logs:\n"
  for (const r of failing)
    reason += r.databaseId
      ? `  gh run view ${r.databaseId} --log-failed\n`
      : `  gh run list --branch ${branch}\n`
  reason +=
    "\n" +
    skillAdvice(
      "ci-status",
      "Use the /ci-status skill to analyze failures and fix them before stopping.",
      [
        `Analyze and fix CI failures before stopping:`,
        `  1. View failure details: gh run view <run-id> --log-failed`,
        `  2. Fix the failing code (type errors, test failures, lint issues)`,
        `  3. Run checks locally: bun run typecheck && bun run lint && bun test`,
        `  4. Commit and push the fix`,
        `  5. Wait for CI to go green: gh run watch <run-id> --exit-status`,
      ].join("\n")
    )
  return reason
}

function buildActiveReason(branch: string, active: CIRun[]): string {
  const names = active.map((r) => `${r.workflowName} (${r.status})`).join(", ")
  let reason = `GitHub CI is still running on branch '${branch}' after waiting ${MAX_POLL_MS / 1000}s.\n\n`
  reason += `Active checks (${active.length}): ${names}\n\n`
  reason += skillAdvice(
    "ci-status",
    "Wait for CI to complete, then check results with the /ci-status skill.",
    [
      `Wait for CI to complete, then check results:`,
      `  gh run list --branch ${branch}`,
      `  gh run watch <run-id> --exit-status`,
      ``,
      `Once complete: if passing → stop. If failing → fix before stopping.`,
    ].join("\n")
  )
  return reason
}

async function main(): Promise<void> {
  const input = stopHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd ?? process.cwd()

  const branch = await resolveTargetBranch(cwd, input.session_id)
  if (!branch) return

  const relevant = await pollUntilComplete(branch, cwd)
  if (!relevant.length) return

  const failing = findFailing(relevant)
  if (failing.length > 0) blockStop(buildFailingReason(branch, failing))

  const stillActive = findActive(relevant)
  if (stillActive.length > 0) blockStop(buildActiveReason(branch, stillActive))
}

if (import.meta.main) void main()
