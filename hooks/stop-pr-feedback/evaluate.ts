import type { ActionPlanItem } from "../../src/action-plan.ts"
import type { SwizHookOutput } from "../../src/SwizHook.ts"
import { blockStopObj, mergeActionPlanIntoTasks } from "../../src/utils/hook-utils.ts"
import { type StopHookInput, stopHookInputSchema } from "../schemas.ts"
import { buildStopPlanSteps, formatStopReason } from "./action-plan.ts"
import { buildStopContext, gatherPRFeedback, resolveRepoContext } from "./context.ts"
import type { StopContext } from "./types.ts"

/** Payload for composing stop-pr-feedback context. */
export type PrFeedbackCollect = {
  stopCtx: StopContext
  planSteps: ActionPlanItem[]
  sessionId: string | null
  cwd: string
  shouldMergeTasks: boolean
}

export async function collectPrFeedbackStopParsed(
  parsed: StopHookInput
): Promise<PrFeedbackCollect | null> {
  try {
    const ctx = await resolveRepoContext(parsed)
    if (!ctx) return null

    const prs = await gatherPRFeedback(ctx.cwd, ctx.currentUser)
    const stopCtx = buildStopContext(ctx, prs)
    if (!stopCtx) return null

    const planSteps = buildStopPlanSteps(stopCtx)

    let shouldMergeTasks = false
    if (ctx.sessionId) {
      const { getSessionIdsForProject } = await import("../../src/tasks/task-resolver.ts")
      const { projectKeyFromCwd } = await import("../../src/project-key.ts")
      const projectKey = projectKeyFromCwd(ctx.cwd)
      const projectSessionIds = await getSessionIdsForProject(projectKey)
      shouldMergeTasks = projectSessionIds.has(ctx.sessionId)
    }

    return {
      stopCtx,
      planSteps,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      shouldMergeTasks,
    }
  } catch {
    return null
  }
}

async function runPrFeedbackBody(input: StopHookInput): Promise<SwizHookOutput> {
  try {
    const parsed = stopHookInputSchema.parse(input)
    const collected = await collectPrFeedbackStopParsed(parsed)
    if (!collected) return {}

    const { planSteps, sessionId, cwd, shouldMergeTasks } = collected
    const reason = formatStopReason(planSteps)

    if (sessionId && shouldMergeTasks) {
      await mergeActionPlanIntoTasks(planSteps, sessionId, cwd)
    }

    return blockStopObj(reason)
  } catch {
    return {}
  }
}

export async function evaluateStopPrFeedback(input: StopHookInput): Promise<SwizHookOutput> {
  return await runPrFeedbackBody(input)
}
