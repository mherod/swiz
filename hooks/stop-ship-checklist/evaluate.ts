/**
 * Main orchestration logic for the unified ship checklist.
 *
 * Coordinates context resolution, parallel workflow collection,
 * result unification, and stop output generation.
 */

import type { SwizHookOutput } from "../../src/SwizHook.ts"
import type { StopHookInput } from "../../src/schemas.ts"
import {
  blockStopObj,
  createSessionTask,
  mergeActionPlanIntoTasks,
} from "../../src/utils/hook-utils.ts"
import { collectGitWorkflowStop, markPushPrompted } from "../stop-git-status.ts"
import { updateCooldown } from "../stop-personal-repo-issues/cooldown.ts"
import { collectPersonalRepoIssuesStopParsed } from "../stop-personal-repo-issues/evaluate.ts"
import { formatStopMessage } from "./action-plan.ts"
import { collectCiWorkflow } from "./ci-workflow.ts"
import { resolveShipChecklistContext } from "./context.ts"
import type { ShipChecklistResult, WorkflowStep } from "./types.ts"

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

  if (gitResult && gitResult.kind === "block") {
    steps.push({
      kind: "git",
      summary: gitResult.summary,
      planSteps: gitResult.steps,
    })
  }

  if (ciResult) {
    steps.push(ciResult)
  }

  if (issuesResult) {
    steps.push({
      kind: "issues",
      summary: "Found unresolved issues that need attention.",
      planSteps: issuesResult.planSteps,
    })
  }

  if (steps.length === 0) return null

  return {
    blocked: true,
    steps,
  }
}

/**
 * Main entry point: evaluate ship checklist and return SwizHookOutput.
 * Emits blockStopObj with unified action plan if any workflows are blocking.
 */
export async function evaluateStopShipChecklist(input: StopHookInput): Promise<SwizHookOutput> {
  try {
    const result = await collectShipChecklistStopParsed(input)
    if (!result || !result.blocked || result.steps.length === 0) {
      return {}
    }

    // Format the unified message
    const message = formatStopMessage(result.steps)

    // Create or update session task
    const sessionId = input.session_id
    const cwd = input.cwd ?? process.cwd()
    if (sessionId) {
      await createSessionTask(
        sessionId,
        "stop-ship-checklist-task-created",
        "Complete ship checklist before stopping",
        "Follow the action plan above to resolve all blocking issues, CI failures, and uncommitted changes."
      )

      // Merge action plan steps into tasks
      for (const step of result.steps) {
        await mergeActionPlanIntoTasks(step.planSteps, sessionId, cwd)
      }

      // Update cooldown for issues if present
      const issuesStep = result.steps.find((s) => s.kind === "issues")
      if (issuesStep) {
        await updateCooldown(sessionId, cwd)
      }

      // Mark push as prompted if git is blocking
      const gitStep = result.steps.find((s) => s.kind === "git")
      if (gitStep) {
        await markPushPrompted(sessionId)
      }
    }

    return blockStopObj(message)
  } catch {
    // Fail-open: any unhandled errors don't block stop
    return {}
  }
}
