import type { ActionPlanItem } from "../../src/action-plan.ts"
import { mergeActionPlanIntoTasks } from "../../src/action-plan.ts"
import type { SwizHookOutput } from "../../src/SwizHook.ts"
import { type StopHookInput, stopHookInputSchema } from "../../src/schemas.ts"
import { readProjectState } from "../../src/settings.ts"
import { stopActionPlan, withStopAction } from "../../src/stop-actions.ts"
import { getDefaultBranch } from "../../src/utils/git-utils.ts"
import { blockStopObj } from "../../src/utils/hook-response.ts"
import { buildIssueStopAction, buildStopPlanSteps, formatStopReason } from "./action-plan.ts"
import {
  buildStopContext,
  gatherStopContext,
  resolveRepoContext,
  shouldUpdateStopCooldown,
} from "./context.ts"
import { updateCooldown } from "./cooldown.ts"
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

export interface PersonalRepoIssuesEvaluationDependencies {
  collect?: (parsed: StopHookInput) => Promise<PersonalRepoIssuesCollect | null>
  mergeTasks?: typeof mergeActionPlanIntoTasks
  updateCooldown?: typeof updateCooldown
}

export async function collectPersonalRepoIssuesStopParsed(
  parsed: StopHookInput
): Promise<PersonalRepoIssuesCollect | null> {
  try {
    const { getEffectiveSwizSettings, readSwizSettings, readProjectSettings } = await import(
      "../../src/settings.ts"
    )
    const settings =
      (parsed._effectiveSettings as ReturnType<typeof getEffectiveSwizSettings> | undefined) ??
      getEffectiveSwizSettings(
        await readSwizSettings(),
        parsed.session_id,
        await readProjectSettings(parsed.cwd ?? process.cwd())
      )
    // Repository ownership alone is not permission to start another backlog item.
    if (!settings.autoContinue) return null
    const ctx = await resolveRepoContext(parsed)
    if (!ctx) return null
    const strictNoDirectMain = settings.strictNoDirectMain

    // Parallelize: project state + issue gathering + default branch (independent)
    const [projectState, gathered, defaultBranch] = await Promise.all([
      readProjectState(ctx.cwd),
      gatherStopContext(
        ctx.cwd,
        ctx.isPersonalRepo,
        ctx.currentUser,
        false, // hasChangesRequested: handled by stop-pr-feedback
        new Set() // allOpenPRIssueNumbers: handled by stop-pr-feedback
      ),
      getDefaultBranch(ctx.cwd),
    ])
    const stopCtx = buildStopContext(ctx, gathered, projectState, strictNoDirectMain, defaultBranch)
    if (!stopCtx) return null

    const planSteps = buildStopPlanSteps(stopCtx, parsed as Record<string, unknown>)

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

async function runPersonalRepoIssuesBody(
  input: StopHookInput,
  dependencies: PersonalRepoIssuesEvaluationDependencies = {}
): Promise<SwizHookOutput> {
  try {
    const parsed = stopHookInputSchema.parse(input)
    const collected = await (dependencies.collect ?? collectPersonalRepoIssuesStopParsed)(parsed)
    if (!collected) return {}

    const { stopCtx, planSteps, sessionId, cwd, shouldMergeTasks, shouldUpdateCooldown } = collected
    const reason = formatStopReason(planSteps, stopCtx)
    const action = buildIssueStopAction(stopCtx)

    if (sessionId && shouldMergeTasks) {
      const nextPlan = stopActionPlan(action, planSteps)
      await (dependencies.mergeTasks ?? mergeActionPlanIntoTasks)(nextPlan, sessionId, cwd)
    }

    if (shouldUpdateCooldown) {
      await (dependencies.updateCooldown ?? updateCooldown)(sessionId, cwd)
    }

    return withStopAction(blockStopObj(reason), action)
  } catch {
    return {}
  }
}

export async function evaluateStopPersonalRepoIssues(
  input: StopHookInput,
  dependencies: PersonalRepoIssuesEvaluationDependencies = {}
): Promise<SwizHookOutput> {
  return await runPersonalRepoIssuesBody(input, dependencies)
}
