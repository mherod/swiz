import type { ActionPlanItem } from "../../src/action-plan.ts"
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
import type { StopContext } from "./types.ts"

/** Payload for composing `stop-ship-checklist` with issues/PR steps. */
export type PersonalRepoIssuesCollect = {
  stopCtx: StopContext
  planSteps: ActionPlanItem[]
  sessionId: string | null
  cwd: string
  shouldMergeTasks: boolean
  shouldUpdateCooldown: boolean
}

export async function collectPersonalRepoIssuesStopParsed(
  parsed: StopHookInput
): Promise<PersonalRepoIssuesCollect | null> {
  try {
    // Parallelize: resolveRepoContext + settings import (independent)
    const [ctx, settingsModule] = await Promise.all([
      resolveRepoContext(parsed),
      import("../../src/settings.ts"),
    ])
    if (!ctx) return null

    const { getEffectiveSwizSettings, readSwizSettings } = settingsModule
    const settings = getEffectiveSwizSettings(await readSwizSettings(), ctx.sessionId)
    const strictNoDirectMain = settings.strictNoDirectMain

    // Parallelize: PR/issue fetching + project state read (independent)
    const [prs, projectState] = await Promise.all([
      getOpenPRsWithFeedback(ctx.cwd, ctx.currentUser),
      readProjectState(ctx.cwd),
    ])
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
    const stopCtx = buildStopContext(ctx, prs, gathered, projectState, strictNoDirectMain)
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
      shouldUpdateCooldown: shouldUpdateStopCooldown(stopCtx),
    }
  } catch {
    return null
  }
}

async function runPersonalRepoIssuesBody(input: StopHookInput): Promise<SwizHookOutput> {
  try {
    const parsed = stopHookInputSchema.parse(input)
    const collected = await collectPersonalRepoIssuesStopParsed(parsed)
    if (!collected) return {}

    const { stopCtx, planSteps, sessionId, cwd, shouldMergeTasks, shouldUpdateCooldown } = collected
    const reason = formatStopReason(planSteps, stopCtx)

    if (sessionId && shouldMergeTasks) {
      await mergeActionPlanIntoTasks(planSteps, sessionId, cwd)
    }

    if (shouldUpdateCooldown) await updateCooldown(sessionId, cwd)

    return blockStopObj(reason)
  } catch {
    return {}
  }
}

export async function evaluateStopPersonalRepoIssues(
  input: StopHookInput
): Promise<SwizHookOutput> {
  return await runPersonalRepoIssuesBody(input)
}
