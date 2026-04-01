#!/usr/bin/env bun

// Unified stop gate: git sync, GitHub CI (feature-branch peer-review mode), and
// actionable issues/PRs — one preamble and one numbered action plan for the agent.
//
// Respects per-gate settings: gitStatusGate, githubCiGate, personalRepoIssuesGate.

import { getCollaborationModePolicy } from "../src/collaboration-policy.ts"
import { getIssueStore, getIssueStoreReader } from "../src/issue-store.ts"
import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { getEffectiveSwizSettings, readProjectSettings, readSwizSettings } from "../src/settings.ts"
import { getEffectiveSwizSettingsForToolHook } from "../src/utils/hook-effective-settings.ts"
import {
  type ActionPlanItem,
  blockStopObj,
  createSessionTask,
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
import {
  collectGitWorkflowStop,
  type GitWorkflowCollectResult,
  markPushPrompted,
} from "./stop-git-status.ts"
import { formatStopIssuesIntro } from "./stop-personal-repo-issues/action-plan.ts"
import { updateCooldown } from "./stop-personal-repo-issues/cooldown.ts"
import { collectPersonalRepoIssuesStopParsed } from "./stop-personal-repo-issues/evaluate.ts"

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
  summary: string
  planSteps: ActionPlanItem[]
}

function buildFailingResult(branch: string, failing: CIRun[]): CIBlockResult {
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
  const planSteps: ActionPlanItem[] = ["Analyze and fix CI failures before stopping:", fixSubSteps]
  return { summary, planSteps }
}

function buildActiveResult(branch: string, active: CIRun[]): CIBlockResult {
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
  const planSteps: ActionPlanItem[] = ["Wait for CI to complete, then check results:", waitSubSteps]
  return { summary, planSteps }
}

/**
 * Evaluate CI gate without emitting stop output — for `stop-ship-checklist` composition.
 */
export async function collectGithubCiStopParsed(
  parsed: StopHookInput
): Promise<CIBlockResult | null> {
  const cwd = parsed.cwd ?? process.cwd()

  const branch = await resolveTargetBranch(cwd, parsed.session_id)
  if (!branch) return null

  const relevant = await pollUntilComplete(branch, cwd)
  if (!relevant.length) return null

  const failing = findFailing(relevant)
  if (failing.length > 0) return buildFailingResult(branch, failing)

  const stillActive = findActive(relevant)
  if (stillActive.length > 0) return buildActiveResult(branch, stillActive)
  return null
}

export async function evaluateStopShipChecklist(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  const cwd = parsed.cwd ?? process.cwd()

  const eff = await getEffectiveSwizSettingsForToolHook({
    cwd,
    session_id: parsed.session_id,
    payload: parsed as Record<string, any>,
  })

  let git: GitWorkflowCollectResult = { kind: "ok" }
  if (eff.gitStatusGate) {
    git = await collectGitWorkflowStop(parsed)
    if (git.kind === "hookOutput") return git.output
  }

  let ci: Awaited<ReturnType<typeof collectGithubCiStopParsed>> = null
  if (eff.githubCiGate) {
    ci = await collectGithubCiStopParsed(parsed)
  }

  let issues: Awaited<ReturnType<typeof collectPersonalRepoIssuesStopParsed>> = null
  if (eff.personalRepoIssuesGate) {
    issues = await collectPersonalRepoIssuesStopParsed(parsed)
  }

  const gitBlock = git.kind === "block"
  const ciBlock = ci !== null
  const issuesBlock = issues !== null

  if (!gitBlock && !ciBlock && !issuesBlock) return {}

  type GitBlocked = Extract<GitWorkflowCollectResult, { kind: "block" }>
  const gitSection: GitBlocked | null = gitBlock ? (git as GitBlocked) : null
  const ciSection = ciBlock ? ci : null
  const issuesSection = issuesBlock ? issues : null

  const summaryParts: string[] = [
    "You cannot stop until everything below is resolved. Follow the single action plan in order.",
  ]

  if (gitSection) summaryParts.push(`### Repository\n${gitSection.summary.trim()}`)
  if (ciSection) summaryParts.push(`### GitHub CI\n${ciSection.summary.trim()}`)
  if (issuesSection) {
    summaryParts.push(
      `### Open issues and pull requests\n${formatStopIssuesIntro(issuesSection.stopCtx).trim()}`
    )
  }

  const combinedPlan: ActionPlanItem[] = []
  if (gitSection) combinedPlan.push(["Repository — commit, pull, and push", gitSection.steps])
  if (ciSection) combinedPlan.push(["CI on your branch", ciSection.planSteps])
  if (issuesSection) combinedPlan.push(["Issues and pull requests", issuesSection.planSteps])

  const sessionId = parsed.session_id

  if (gitSection) {
    if (gitSection.willNeedPush) await markPushPrompted(gitSection.sessionId)
    const extras: string[] = []
    if (ciSection) extras.push("CI")
    if (issuesSection) extras.push("issues/PRs")
    const taskSubject =
      extras.length > 0 ? "Complete ship checklist before stopping" : gitSection.taskSubject
    const taskDesc =
      extras.length > 0
        ? `${gitSection.taskDesc} Also complete ${extras.join(" and ")} using the plan below.`
        : gitSection.taskDesc
    await createSessionTask(
      gitSection.sessionId,
      "stop-git-workflow-task-created",
      taskSubject,
      taskDesc
    )
  }

  if (ciSection && sessionId) {
    await mergeActionPlanIntoTasks(ciSection.planSteps, sessionId, cwd)
  }

  if (issuesSection && sessionId && issuesSection.shouldMergeTasks) {
    await mergeActionPlanIntoTasks(issuesSection.planSteps, sessionId, cwd)
  }

  if (issuesSection?.shouldUpdateCooldown) {
    await updateCooldown(issuesSection.sessionId, issuesSection.cwd)
  }

  const preamble = `${summaryParts.join("\n\n")}\n\n`
  const plan = formatActionPlan(combinedPlan, {
    header: "Single action plan (do in this order):",
    translateToolNames: true,
  })

  return blockStopObj(preamble + plan)
}

const stopShipChecklist: SwizStopHook = {
  name: "stop-ship-checklist",
  event: "stop",
  timeout: 65,

  run(input) {
    return evaluateStopShipChecklist(input)
  },
}

export default stopShipChecklist

if (import.meta.main) {
  await runSwizHookAsMain(stopShipChecklist)
}
