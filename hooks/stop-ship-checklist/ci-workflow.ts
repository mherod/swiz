/**
 * GitHub CI workflow collection for the unified ship checklist.
 *
 * Handles CI run polling, filtering (active vs failing), and action plan
 * generation. Uses store-first caching to minimize API calls.
 */

import { getIssueStore, getIssueStoreReader } from "../../src/issue-store.ts"
import type { StopHookInput } from "../../src/schemas.ts"
import type { ActionPlanItem } from "../../src/utils/hook-utils.ts"
import {
  getDefaultBranch,
  getRepoSlug,
  ghJson,
  git,
  hasGhCli,
  isDefaultBranch,
  isGitHubRemote,
  skillExists,
} from "../../src/utils/hook-utils.ts"
import type { WorkflowStep } from "./types.ts"

// CI poll budget for the stop-ship checklist. MAX_POLL_MS caps the total
// wall-clock time the hook will spend waiting for in-flight CI to settle;
// POLL_INTERVAL_MS is the gap between fetches. With MAX_POLL_MS=15000 and
// POLL_INTERVAL_MS=5000 the loop does at most 3 sleep iterations (~15s
// wall-clock), keeping the hook well inside its 65s timeout budget. Exported
// so unit tests can pin the bound (issue #509).
export const POLL_INTERVAL_MS = 5_000
export const MAX_POLL_MS = 15_000

export interface CIRun {
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

function findActive(runs: CIRun[]): CIRun[] {
  return runs.filter((r) => r.status === "in_progress" || r.status === "queued")
}

function findFailing(runs: CIRun[]): CIRun[] {
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

async function resolveTargetBranch(cwd: string): Promise<string | null> {
  if (!(await isGitHubRemote(cwd))) return null
  if (!hasGhCli()) return null
  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return null
  const defaultBranch = await getDefaultBranch(cwd)
  if (isDefaultBranch(branch, defaultBranch)) return null
  return branch
}

/**
 * Injection seam for tests: the poll loop accepts a fetcher (defaulting to
 * the real `fetchRuns`) and a sleep function (defaulting to `Bun.sleep`).
 * The default behaviour is unchanged — the extra parameters only exist so
 * unit tests can drive the loop without real subprocesses or real time.
 */
export interface PollDeps {
  fetcher: (branch: string, cwd: string) => Promise<CIRun[]>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

const defaultPollDeps: PollDeps = {
  fetcher: fetchRuns,
  sleep: (ms) => Bun.sleep(ms),
  now: () => Date.now(),
}

export async function pollUntilComplete(
  branch: string,
  cwd: string,
  deps: PollDeps = defaultPollDeps
): Promise<CIRun[]> {
  let relevant = await deps.fetcher(branch, cwd)
  if (!relevant.length) return relevant
  if (findActive(relevant).length === 0) return relevant

  const deadline = deps.now() + MAX_POLL_MS
  while (deps.now() < deadline && findActive(relevant).length > 0) {
    await deps.sleep(POLL_INTERVAL_MS)
    relevant = await deps.fetcher(branch, cwd)
  }
  return relevant
}

function buildFailingResult(branch: string, failing: CIRun[]): WorkflowStep {
  const names = failing.map((r) => `${r.workflowName} (${r.conclusion})`).join(", ")
  let summary = `GitHub CI is failing on branch '${branch}'.\n\n`
  summary += `Failing checks (${failing.length}): ${names}\n\n`
  summary += "To view failure logs:\n"
  for (const r of failing)
    summary += r.databaseId
      ? `  gh run view ${r.databaseId} --log-failed\n`
      : `  gh run list --branch ${branch}\n`
  summary += "\n"

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

  return {
    kind: "ci",
    summary,
    planSteps: ["Analyze and fix CI failures before stopping:", fixSubSteps],
  }
}

function buildActiveResult(branch: string, active: CIRun[]): WorkflowStep {
  const names = active.map((r) => `${r.workflowName} (${r.status})`).join(", ")
  let summary = `GitHub CI is still running on branch '${branch}' after waiting ${MAX_POLL_MS / 1000}s.\n\n`
  summary += `Active checks (${active.length}): ${names}\n\n`

  const waitSubSteps: ActionPlanItem[] = []
  if (skillExists("ci-status")) {
    waitSubSteps.push("/ci-status — Check results once CI completes")
  }
  waitSubSteps.push(
    `gh run list --branch ${branch}`,
    "gh run watch <run-id> --exit-status",
    "Once complete: if passing → stop. If failing → fix before stopping."
  )

  return {
    kind: "ci",
    summary,
    planSteps: ["Wait for CI to complete, then check results:", waitSubSteps],
  }
}

/**
 * Evaluate GitHub CI workflow: poll for active/failing runs and return
 * a structured workflow step if CI is blocking, or null if not blocking.
 *
 * Fail-open: returns null on missing prerequisites (no branch, no GitHub remote, no gh CLI).
 */
export async function collectCiWorkflow(input: StopHookInput): Promise<WorkflowStep | null> {
  const cwd = input.cwd ?? process.cwd()

  try {
    const branch = await resolveTargetBranch(cwd)
    if (!branch) return null

    const relevant = await pollUntilComplete(branch, cwd)
    if (!relevant.length) return null

    const failing = findFailing(relevant)
    if (failing.length > 0) return buildFailingResult(branch, failing)

    const stillActive = findActive(relevant)
    if (stillActive.length > 0) return buildActiveResult(branch, stillActive)

    return null
  } catch {
    // Fail-open: any error returns null
    return null
  }
}
