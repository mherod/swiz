import type { SwizHookOutput } from "../../src/SwizHook.ts"
import { readProjectState } from "../../src/settings.ts"
import { blockStopObj, mergeActionPlanIntoTasks } from "../../src/utils/hook-utils.ts"
import { type StopHookInput, stopHookInputSchema } from "../schemas.ts"
import { buildStopPlanSteps, formatStopReason } from "./action-plan.ts"
import {
  buildStopContext,
  gatherStopContext,
  resolveRepoContext,
  shouldUpdateStopCooldown,
} from "./context.ts"
import { updateCooldown } from "./cooldown.ts"
import {
  extractAllOpenPRIssueNumbers,
  getOpenPRsWithFeedback,
  openPrNeedsStopAttention,
} from "./pull-requests.ts"

async function runPersonalRepoIssuesBody(input: StopHookInput): Promise<SwizHookOutput> {
  try {
    const parsed = stopHookInputSchema.parse(input)
    const ctx = await resolveRepoContext(parsed)
    if (!ctx) return {}

    const { getEffectiveSwizSettings, readSwizSettings } = await import("../../src/settings.ts")
    const settings = getEffectiveSwizSettings(await readSwizSettings(), ctx.sessionId)
    const strictNoDirectMain = settings.strictNoDirectMain

    const prs = await getOpenPRsWithFeedback(ctx.cwd, ctx.currentUser)
    const hasChangesRequested = prs.some(
      (p) => openPrNeedsStopAttention(p) && p.reviewDecision === "CHANGES_REQUESTED"
    )
    const allOpenPRIssueNumbers = extractAllOpenPRIssueNumbers(prs)
    const gathered = await gatherStopContext(
      ctx.cwd,
      ctx.isPersonalRepo,
      ctx.currentUser,
      hasChangesRequested,
      allOpenPRIssueNumbers
    )

    const projectState = await readProjectState(ctx.cwd)
    const stopCtx = buildStopContext(ctx, prs, gathered, projectState, strictNoDirectMain)
    if (!stopCtx) return {}

    const planSteps = buildStopPlanSteps(stopCtx)
    const reason = formatStopReason(planSteps, stopCtx)

    if (ctx.sessionId) {
      const { getSessionIdsForProject } = await import("../../src/tasks/task-resolver.ts")
      const { projectKeyFromCwd } = await import("../../src/project-key.ts")
      const projectKey = projectKeyFromCwd(ctx.cwd)
      const projectSessionIds = await getSessionIdsForProject(projectKey)
      if (projectSessionIds.has(ctx.sessionId)) {
        await mergeActionPlanIntoTasks(planSteps, ctx.sessionId, ctx.cwd)
      }
    }

    if (shouldUpdateStopCooldown(stopCtx)) await updateCooldown(ctx.sessionId, ctx.cwd)

    return blockStopObj(reason, { includeUpdateMemoryAdvice: false })
  } catch {
    return {}
  }
}

export async function evaluateStopPersonalRepoIssues(
  input: StopHookInput
): Promise<SwizHookOutput> {
  return await runPersonalRepoIssuesBody(input)
}
