/**
 * Main orchestration logic for the unified ship checklist.
 *
 * Coordinates context resolution, parallel workflow collection,
 * result unification, and stop output generation.
 */

import { mergeActionPlanIntoTasks } from "../../src/action-plan.ts"
import type { SwizHookOutput } from "../../src/SwizHook.ts"
import type { StopHookInput } from "../../src/schemas.ts"
import { stopActionPriority } from "../../src/stop-actions.ts"
import { blockStopObj } from "../../src/utils/hook-response.ts"
import { completeSessionTask, createSessionTask } from "../../src/utils/session-task-io.ts"
import type { GitWorkflowCollectResult } from "../stop-git-status/types.ts"
import { collectGitWorkflowStop, markPushPrompted } from "../stop-git-status.ts"
import { buildIssueStopAction } from "../stop-personal-repo-issues/action-plan.ts"
import { updateCooldown } from "../stop-personal-repo-issues/cooldown.ts"
import { collectPersonalRepoIssuesStopParsed } from "../stop-personal-repo-issues/evaluate.ts"
import { formatStopMessage } from "./action-plan.ts"
import { collectCiWorkflow } from "./ci-workflow.ts"
import { resolveShipChecklistContext } from "./context.ts"
import type { ShipChecklistResult, WorkflowStep } from "./types.ts"

const SHIP_CHECKLIST_TASK_SUBJECT = "Complete ship checklist before stopping"
const SHIP_CHECKLIST_COMPLETION_EVIDENCE = "note:ship checklist passed"

function nextChecklistStep(steps: WorkflowStep[]): WorkflowStep | undefined {
  return steps.toSorted(
    (a, b) =>
      stopActionPriority(a.action) - stopActionPriority(b.action) ||
      (a.action?.id ?? "").localeCompare(b.action?.id ?? "")
  )[0]
}

function collectGitStep(result: GitWorkflowCollectResult | null): WorkflowStep | null {
  if (result?.kind === "block") {
    return { kind: "git", summary: result.summary, planSteps: result.steps, action: result.action }
  }
  if (result?.kind === "hookOutput" && "reason" in result.output) {
    return { kind: "git", summary: result.output.reason, planSteps: [result.output.reason] }
  }
  return null
}

async function isProjectAffiliated(sessionId: string, cwd: string): Promise<boolean> {
  const { getSessionIdsForProject } = await import("../../src/tasks/task-resolver.ts")
  const { projectKeyFromCwd } = await import("../../src/project-key.ts")
  const projectKey = projectKeyFromCwd(cwd)
  const projectSessionIds = await getSessionIdsForProject(projectKey)
  return projectSessionIds.has(sessionId)
}

async function mergeChecklistStepsIntoTasks(
  steps: WorkflowStep[],
  sessionId: string,
  cwd: string
): Promise<void> {
  const mergeIssueSteps = await isProjectAffiliated(sessionId, cwd)
  const next = nextChecklistStep(steps)
  for (const step of next ? [next] : []) {
    if (step.kind === "issues" && !mergeIssueSteps) continue
    const plan = step.action
      ? [step.action.title, [step.action.instruction, step.action.doneWhen]]
      : step.planSteps
    await mergeActionPlanIntoTasks(plan, sessionId, cwd)
  }
}

export async function prepareBlockingChecklistTasks(
  result: ShipChecklistResult,
  sessionId: string,
  cwd: string
): Promise<void> {
  await createSessionTask(
    sessionId,
    "stop-ship-checklist-task-created",
    SHIP_CHECKLIST_TASK_SUBJECT,
    "Complete the selected action, then reassess the remaining checklist findings.",
    cwd
  )
  await mergeChecklistStepsIntoTasks(result.steps, sessionId, cwd)

  if (nextChecklistStep(result.steps)?.kind === "issues") {
    await updateCooldown(sessionId, cwd)
  }
  if (nextChecklistStep(result.steps)?.kind === "git") {
    await markPushPrompted(sessionId)
  }
}

/**
 * Evaluate all three ship checklist workflows in parallel and unify results.
 * Returns structured workflow steps if any are blocking, null otherwise.
 *
 * Fail-open: any errors are caught and return null/empty.
 */
export async function collectShipChecklistStopParsed(
  input: StopHookInput
): Promise<ShipChecklistResult | null> {
  // Load context and prerequisite settings
  const context = await resolveShipChecklistContext(input)
  if (!context) return null

  // Collect all three workflows in parallel
  const [gitResult, ciResult, issuesResult] = await Promise.all([
    context.gates.git ? collectGitWorkflowStop(input) : Promise.resolve(null),
    context.gates.ci ? collectCiWorkflow(input) : Promise.resolve(null),
    context.gates.issues ? collectPersonalRepoIssuesStopParsed(input) : Promise.resolve(null),
  ])

  // Determine which are blocking
  const steps: WorkflowStep[] = []

  const gitStep = collectGitStep(gitResult)
  if (gitStep) steps.push(gitStep)

  if (ciResult) {
    steps.push(ciResult)
  }

  if (issuesResult) {
    steps.push({
      kind: "issues",
      summary: "Found unresolved issues that need attention.",
      planSteps: issuesResult.planSteps,
      action: buildIssueStopAction(issuesResult.stopCtx),
    })
  }

  return {
    blocked: steps.length > 0,
    steps,
    context: gitResult?.kind === "ok" ? gitResult.context : undefined,
  }
}

/**
 * Main entry point: evaluate ship checklist and return SwizHookOutput.
 * Emits blockStopObj with unified action plan if any workflows are blocking.
 */
export async function evaluateStopShipChecklist(input: StopHookInput): Promise<SwizHookOutput> {
  try {
    const result = await collectShipChecklistStopParsed(input)
    if (!result) return {}
    if (!result.blocked || result.steps.length === 0) {
      await settleShipChecklistTask(input, result)
      return result.context ? { systemMessage: result.context } : {}
    }

    const message = [result.context, formatStopMessage(result.steps)].filter(Boolean).join("\n\n")
    const sessionId = input.session_id
    const cwd = input.cwd ?? process.cwd()
    if (sessionId) {
      await prepareBlockingChecklistTasks(result, sessionId, cwd)
    }

    // Never hide an unmigrated workflow's recovery constraints behind a compact action.
    const actions = result.steps.flatMap((step) => (step.action ? [step.action] : []))
    return {
      ...blockStopObj(message),
      ...(actions.length === result.steps.length ? { _stopActions: actions } : {}),
    }
  } catch {
    // Fail-open: any unhandled errors don't block stop
    return {}
  }
}

type CompleteShipChecklistTask = typeof completeSessionTask

/** Complete the hook-owned task only after a successfully evaluated clean checklist. */
export async function settleShipChecklistTask(
  input: StopHookInput,
  result: ShipChecklistResult | null,
  completeTask: CompleteShipChecklistTask = completeSessionTask
): Promise<boolean> {
  if (!result || result.blocked || result.steps.length > 0 || !input.session_id) {
    return false
  }

  return await completeTask(input.session_id, SHIP_CHECKLIST_TASK_SUBJECT, {
    cwd: input.cwd ?? process.cwd(),
    evidence: SHIP_CHECKLIST_COMPLETION_EVIDENCE,
  })
}
