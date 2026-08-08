/**
 * Main orchestration module for stop-git-status.
 *
 * Resolves context, runs validators, builds action plan, and returns blocking output.
 * Exported for composition with stop-ship-checklist.
 */

import { formatActionPlan } from "../../src/action-plan.ts"
import { git } from "../../src/git-helpers.ts"
import type { SwizHookOutput } from "../../src/SwizHook.ts"
import type { StopHookInput } from "../../src/schemas.ts"
import { blockStopObj } from "../../src/utils/hook-response.ts"
import { createSessionTask } from "../../src/utils/session-task-io.ts"
import { buildGitWorkflowSections } from "./action-plan.ts"
import { detectBackgroundPush } from "./background-push-detector.ts"
import { resolveGitContext } from "./context.ts"
import { isPushCooldownActive, markPushPrompted } from "./push-cooldown-validator.ts"
import { buildTaskDesc, describeRemoteState, selectTaskSubject } from "./remote-state-validator.ts"
import type { GitWorkflowCollectResult } from "./types.ts"
import { buildUncommittedReason } from "./uncommitted-changes-validator.ts"

interface DetachedMainWorktree {
  path: string
  commit: string
}

function parseDetachedMainWorktree(porcelain: string): DetachedMainWorktree | null {
  const mainWorktree = porcelain.split("\0\0", 1)[0]
  if (!mainWorktree) return null

  const fields = mainWorktree.split("\0")
  if (!fields.includes("detached")) return null

  const path = fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length)
  const commit = fields.find((field) => field.startsWith("HEAD "))?.slice("HEAD ".length)
  if (!path || !commit) return null

  return { path, commit }
}

async function collectDetachedMainWorktreeStop(
  input: StopHookInput
): Promise<GitWorkflowCollectResult | null> {
  const cwd = input.cwd ?? process.cwd()
  const state = parseDetachedMainWorktree(await git(["worktree", "list", "--porcelain", "-z"], cwd))
  if (!state) return null

  const shortCommit = state.commit.slice(0, 12)
  const summary =
    `The main Git worktree is on a detached HEAD at ${shortCommit}.\n\n` +
    `Main worktree: ${state.path}\n\n` +
    "Stop is blocked until the main worktree is attached to a branch."
  const steps = [
    "Reattach the main worktree HEAD:",
    [
      `Open the main worktree at ${state.path}`,
      `If the detached commit must be preserved: git switch -c <branch> ${shortCommit}`,
      "Otherwise switch to the intended existing branch: git switch <branch>",
      "Verify the result: git status --short --branch",
    ],
  ]

  return {
    kind: "block",
    summary,
    steps,
    willNeedPush: false,
    sessionId: input.session_id,
    cwd: state.path,
    taskSubject: "Reattach main worktree HEAD",
    taskDesc: `note: main worktree detached at ${state.commit}`,
  }
}

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
async function collectGitWorkflowStopAfterDetachedCheck(
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

  const details = hasUncommitted
    ? buildUncommittedReason(gitStatus, upstream, behind)
    : describeRemoteState(branch, upstream, ahead, behind)
  const summary = `${ctx.summary}\n\n${details}`

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
    hookPayload: input as Record<string, unknown>,
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

export async function collectGitWorkflowStop(
  input: StopHookInput
): Promise<GitWorkflowCollectResult> {
  const detachedMainWorktree = await collectDetachedMainWorktreeStop(input)
  if (detachedMainWorktree) return detachedMainWorktree
  return await collectGitWorkflowStopAfterDetachedCheck(input)
}

/**
 * Main evaluation: check git status and return blocking output or empty object.
 */
export async function evaluateStopGitStatus(input: StopHookInput): Promise<SwizHookOutput> {
  const detachedMainWorktree = await collectDetachedMainWorktreeStop(input)
  if (detachedMainWorktree?.kind === "block") {
    await createSessionTask(
      detachedMainWorktree.sessionId,
      "stop-git-workflow-task-created",
      detachedMainWorktree.taskSubject,
      detachedMainWorktree.taskDesc
    )
    return blockStopObj(
      `${detachedMainWorktree.summary}\n\n${formatActionPlan(detachedMainWorktree.steps)}`
    )
  }

  const pushShortCircuit = await checkPushCooldownOrInFlight(input)
  if (pushShortCircuit !== null) return pushShortCircuit

  const r = await collectGitWorkflowStopAfterDetachedCheck(input)
  if (r.kind === "ok") return {}
  if (r.kind === "hookOutput") return r.output

  if (r.willNeedPush) await markPushPrompted(r.sessionId)
  await createSessionTask(r.sessionId, "stop-git-workflow-task-created", r.taskSubject, r.taskDesc)
  return blockStopObj(r.summary + formatActionPlan(r.steps))
}
