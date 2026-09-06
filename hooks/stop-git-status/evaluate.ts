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
import {
  appendSessionFileOwnershipContext,
  buildOwnershipHoldReason,
  resolvePeerHeldFiles,
} from "../../src/utils/session-file-ownership.ts"
import { createSessionTask } from "../../src/utils/session-task-io.ts"
import { buildGitWorkflowSections } from "./action-plan.ts"
import { detectBackgroundPush } from "./background-push-detector.ts"
import { resolveGitContext } from "./context.ts"
import { isPushCooldownActive, markPushPrompted } from "./push-cooldown-validator.ts"
import { buildTaskDesc, describeRemoteState, selectTaskSubject } from "./remote-state-validator.ts"
import type { GitContext, GitWorkflowCollectResult } from "./types.ts"
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
  const cwd = input.cwd
  if (!cwd?.trim()) {
    const reason = buildOwnershipHoldReason({ known: false, reason: "missing-cwd" })
    return {
      kind: "hookOutput",
      output: { ...blockStopObj(reason), reason },
    }
  }
  const state = parseDetachedMainWorktree(await git(["worktree", "list", "--porcelain", "-z"], cwd))
  if (!state) return null

  const shortCommit = state.commit.slice(0, 12)
  const summary =
    `The main Git worktree is on a detached HEAD at ${shortCommit}.\n\n` +
    `Main worktree: ${state.path}\n\n` +
    "Stop is blocked until the main worktree is attached to a branch."
  const ownership = await resolvePeerHeldFiles(state.path, input.session_id)
  const hold = buildOwnershipHoldReason(ownership)
  const steps = hold
    ? [hold]
    : [
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

  if (hasUnresolvedUpstream(ctx) || branch === "(detached)") return null

  if (!hasUncommitted && ahead > 0 && behind === 0) {
    if (await detectBackgroundPush(cwd)) {
      return blockStopObj(
        "A `git push` is currently running in the background.\n\n" +
          "Wait for it to complete before stopping. " +
          "Check the background task output with `TaskOutput <task-id>` to verify it succeeded, " +
          "then try stopping again."
      )
    }
    if (await isPushCooldownActive(sessionId, cwd, branch, pushCooldownMinutes)) {
      return {}
    }
  }

  return null
}

function hasUnresolvedUpstream(ctx: GitContext): boolean {
  return ctx.gitStatus.upstreamGone || (ctx.hasRemote && !ctx.gitStatus.upstream)
}

function hasOutstandingGitWork(ctx: GitContext): boolean {
  const { ahead, behind, branch } = ctx.gitStatus
  return (
    ctx.hasUncommitted ||
    ahead > 0 ||
    behind > 0 ||
    hasUnresolvedUpstream(ctx) ||
    branch === "(detached)"
  )
}

function satisfiedGitResult(ctx: GitContext): GitWorkflowCollectResult {
  if (!ctx.ownership.known || ctx.gitStatus.total === 0) return { kind: "ok" }
  return {
    kind: "ok",
    context: appendSessionFileOwnershipContext(
      "Only other active sessions have uncommitted changes. Leave their files untouched.",
      ctx.ownership.ownership
    ),
  }
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
  if (!hasOutstandingGitWork(ctx)) return satisfiedGitResult(ctx)

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
  const unresolvedUpstream = hasUnresolvedUpstream(ctx)

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
    ownership: ctx.ownership,
  })
  if (unresolvedUpstream) {
    steps.push(
      "Inspect upstream tracking with git branch -vv and resolve the missing upstream before stopping."
    )
  }
  if (branch === "(detached)" && steps.length === 0) {
    steps.push("Inspect the detached worktree and its ownership before choosing a recovery branch.")
  }

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
  if (detachedMainWorktree?.kind === "hookOutput") return detachedMainWorktree.output
  if (detachedMainWorktree?.kind === "block") {
    await createSessionTask(
      detachedMainWorktree.sessionId,
      "stop-git-workflow-task-created",
      detachedMainWorktree.taskSubject,
      detachedMainWorktree.taskDesc,
      detachedMainWorktree.cwd
    )
    return blockStopObj(
      `${detachedMainWorktree.summary}\n\n${formatActionPlan(detachedMainWorktree.steps)}`
    )
  }

  const pushShortCircuit = await checkPushCooldownOrInFlight(input)
  if (pushShortCircuit !== null) return pushShortCircuit

  const r = await collectGitWorkflowStopAfterDetachedCheck(input)
  if (r.kind === "ok") return r.context ? { systemMessage: r.context } : {}
  if (r.kind === "hookOutput") return r.output

  if (r.willNeedPush) await markPushPrompted(r.sessionId)
  await createSessionTask(
    r.sessionId,
    "stop-git-workflow-task-created",
    r.taskSubject,
    r.taskDesc,
    r.cwd
  )
  return blockStopObj(r.summary + formatActionPlan(r.steps))
}
