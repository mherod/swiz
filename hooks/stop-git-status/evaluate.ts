/**
 * Main orchestration module for stop-git-status.
 *
 * Resolves context, runs validators, builds action plan, and returns blocking output.
 * Exported for composition with stop-ship-checklist.
 */

import type { SwizHookOutput } from "../../src/SwizHook.ts"
import type { StopHookInput } from "../../src/schemas.ts"
import { blockStopObj, createSessionTask, formatActionPlan } from "../../src/utils/hook-utils.ts"
import { buildGitWorkflowSections } from "./action-plan.ts"
import { detectBackgroundPush } from "./background-push-detector.ts"
import { resolveGitContext } from "./context.ts"
import { isPushCooldownActive, markPushPrompted } from "./push-cooldown-validator.ts"
import { buildTaskDesc, describeRemoteState, selectTaskSubject } from "./remote-state-validator.ts"
import type { GitWorkflowCollectResult } from "./types.ts"
import { buildUncommittedReason } from "./uncommitted-changes-validator.ts"

/**
 * Check for push cooldown or in-flight push.
 * Returns early decision or null to continue evaluation.
 */
async function checkPushCooldownOrInFlight(input: StopHookInput): Promise<SwizHookOutput | null> {
  const ctx = await resolveGitContext(input)
  if (!ctx) return null

  const {
    hasUncommitted,
    sessionId,
    cwd,
    gitStatus: { ahead, behind, branch },
    pushCooldownMinutes,
  } = ctx

  if (!hasUncommitted && behind === 0 && ahead > 0) {
    if (await isPushCooldownActive(sessionId, cwd, branch, pushCooldownMinutes)) {
      return {}
    }
  }

  if (!hasUncommitted && ahead > 0 && behind === 0) {
    if (await detectBackgroundPush(cwd)) {
      return blockStopObj(
        "A `git push` is currently running in the background.\n\n" +
          "Wait for it to complete before stopping. " +
          "Check the background task output with `TaskOutput <task-id>` to verify it succeeded, " +
          "then try stopping again."
      )
    }
  }

  return null
}

/**
 * Evaluate git status without blocking.
 * Used by stop-ship-checklist to merge git, CI, and issues into one action plan.
 */
export async function collectGitWorkflowStop(
  input: StopHookInput
): Promise<GitWorkflowCollectResult> {
  const ctx = await resolveGitContext(input)
  if (!ctx) return { kind: "ok" }

  const {
    hasUncommitted,
    hasRemote,
    upstream,
    cwd,
    collabMode,
    trunkMode,
    defaultBranch,
    sessionId,
    gitStatus,
  } = ctx

  const { branch, ahead, behind } = gitStatus

  const summary = hasUncommitted
    ? buildUncommittedReason(gitStatus, upstream, behind)
    : describeRemoteState(branch, upstream, ahead, behind)

  const steps = buildGitWorkflowSections({
    summary,
    hasUncommitted,
    hasRemote,
    behind,
    ahead,
    branch,
    upstream,
    collabMode,
    trunkMode,
    defaultBranch,
  })

  const willNeedPush = ahead > 0 || (hasUncommitted && hasRemote)
  const taskSubject = selectTaskSubject(hasUncommitted, ahead, behind)
  const taskDesc = buildTaskDesc({ cwd, hasUncommitted, branch, upstream, behind, ahead })

  return {
    kind: "block",
    summary,
    steps,
    willNeedPush,
    sessionId,
    cwd,
    taskSubject,
    taskDesc,
  }
}

/**
 * Main evaluation: check git status and return blocking output or empty object.
 */
export async function evaluateStopGitStatus(input: StopHookInput): Promise<SwizHookOutput> {
  const pushShortCircuit = await checkPushCooldownOrInFlight(input)
  if (pushShortCircuit !== null) return pushShortCircuit

  const r = await collectGitWorkflowStop(input)
  if (r.kind === "ok") return {}
  if (r.kind === "hookOutput") return r.output

  if (r.willNeedPush) await markPushPrompted(r.sessionId)
  await createSessionTask(r.sessionId, "stop-git-workflow-task-created", r.taskSubject, r.taskDesc)
  return blockStopObj(r.summary + formatActionPlan(r.steps))
}
