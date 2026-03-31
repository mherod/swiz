#!/usr/bin/env bun

// Unified stop gate: git sync, GitHub CI (feature-branch peer-review mode), and
// actionable issues/PRs — one preamble and one numbered action plan for the agent.
//
// Respects per-gate settings: gitStatusGate, githubCiGate, personalRepoIssuesGate.

import type { ActionPlanItem } from "../src/action-plan.ts"
import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { getEffectiveSwizSettingsForToolHook } from "../src/utils/hook-effective-settings.ts"
import {
  blockStopObj,
  createSessionTask,
  formatActionPlan,
  mergeActionPlanIntoTasks,
} from "../src/utils/hook-utils.ts"
import { type StopHookInput, stopHookInputSchema } from "./schemas.ts"
import {
  collectGitWorkflowStop,
  type GitWorkflowCollectResult,
  markPushPrompted,
} from "./stop-git-status.ts"
import { collectGithubCiStopParsed } from "./stop-github-ci.ts"
import { formatStopIssuesIntro } from "./stop-personal-repo-issues/action-plan.ts"
import { updateCooldown } from "./stop-personal-repo-issues/cooldown.ts"
import { collectPersonalRepoIssuesStopParsed } from "./stop-personal-repo-issues/evaluate.ts"

export async function evaluateStopShipChecklist(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  const cwd = parsed.cwd ?? process.cwd()

  const eff = await getEffectiveSwizSettingsForToolHook({
    cwd,
    session_id: parsed.session_id,
    payload: parsed as Record<string, unknown>,
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

  return blockStopObj(preamble + plan, { includeUpdateMemoryAdvice: !issuesSection })
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
