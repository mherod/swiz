/**
 * Main orchestration module for stop-git-status.
 *
 * Resolves context, runs validators, builds action plan, and returns blocking output.
 * Exported for composition with stop-ship-checklist.
 */

import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { formatActionPlan } from "../../src/action-plan.ts"
import { git } from "../../src/git-helpers.ts"
import type { SwizHookOutput } from "../../src/SwizHook.ts"
import type { StopHookInput } from "../../src/schemas.ts"
import { withStopAction } from "../../src/stop-actions.ts"
import { stopContinuationModeForHook } from "../../src/stop-continuation.ts"
import { blockStopObj } from "../../src/utils/hook-response.ts"
import {
  appendSessionFileOwnershipContext,
  buildOwnershipHoldReason,
  resolvePeerHeldFiles,
} from "../../src/utils/session-file-ownership.ts"
import { createSessionTask } from "../../src/utils/session-task-io.ts"
import { buildCommitSteps, buildGitWorkflowSections } from "./action-plan.ts"
import { detectBackgroundPush } from "./background-push-detector.ts"
import { resolveGitContext } from "./context.ts"
import { buildGitStopAction } from "./next-action.ts"
import { isPushCooldownActive, markPushPrompted } from "./push-cooldown-validator.ts"
import { buildTaskDesc, describeRemoteState, selectTaskSubject } from "./remote-state-validator.ts"
import type { GitContext, GitWorkflowCollectResult } from "./types.ts"
import { buildUncommittedReason } from "./uncommitted-changes-validator.ts"

interface DetachedMainWorktree {
  path: string
  commit: string
}

/** Which checkout is detached: the repository's main worktree, or the session's own worktree. */
type DetachedWorktreeRole = "main" | "current"

/** A git operation that legitimately detaches HEAD and must be finished, not switched away from. */
type DetachedHeadOperation = "rebase" | "bisect"

interface DetachedWorktree extends DetachedMainWorktree {
  role: DetachedWorktreeRole
  operation: DetachedHeadOperation | null
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

/** The session's own worktree when its HEAD is detached (symbolic-ref fails, HEAD resolves). */
async function findDetachedCurrentWorktree(cwd: string): Promise<DetachedMainWorktree | null> {
  if (await git(["symbolic-ref", "-q", "HEAD"], cwd)) return null
  const [commit, path] = await Promise.all([
    git(["rev-parse", "--verify", "-q", "HEAD"], cwd),
    git(["rev-parse", "--show-toplevel"], cwd),
  ])
  if (!commit || !path) return null
  return { path, commit }
}

const OPERATION_MARKERS: ReadonlyArray<readonly [DetachedHeadOperation, string]> = [
  ["rebase", "rebase-merge"],
  ["rebase", "rebase-apply"],
  ["bisect", "BISECT_LOG"],
]

/** Rebase and bisect state live in the per-worktree git dir, so resolve each marker there. */
async function detectDetachedHeadOperation(
  worktree: string
): Promise<DetachedHeadOperation | null> {
  for (const [operation, marker] of OPERATION_MARKERS) {
    const markerPath = await git(["rev-parse", "--git-path", marker], worktree)
    if (!markerPath) continue
    const present = await stat(resolve(worktree, markerPath)).then(
      () => true,
      () => false
    )
    if (present) return operation
  }
  return null
}

async function findDetachedWorktree(cwd: string): Promise<DetachedWorktree | null> {
  const main = parseDetachedMainWorktree(await git(["worktree", "list", "--porcelain", "-z"], cwd))
  const state = main ?? (await findDetachedCurrentWorktree(cwd))
  if (!state) return null
  return {
    ...state,
    role: main ? "main" : "current",
    operation: await detectDetachedHeadOperation(state.path),
  }
}

function detachedRecoverySteps(state: DetachedWorktree): [string, string[]] {
  const label = state.role === "main" ? "the main worktree" : "this worktree"
  const open = `Open ${label} at ${state.path}`
  if (state.operation === "rebase") {
    return [
      `Finish the rebase in progress in ${label}:`,
      [
        open,
        "Resolve any conflicts, stage them, then: git rebase --continue",
        "Or return to the original branch: git rebase --abort",
        "Verify the result: git status --short --branch",
      ],
    ]
  }
  if (state.operation === "bisect") {
    return [
      `End the bisect in progress in ${label}:`,
      [
        open,
        "Record the result you need, then: git bisect reset",
        "Verify the result: git status --short --branch",
      ],
    ]
  }
  const shortCommit = state.commit.slice(0, 12)
  return [
    `Reattach ${label} HEAD:`,
    [
      open,
      `If the detached commit must be preserved: git switch -c <branch> ${shortCommit}`,
      "Otherwise switch to the intended existing branch: git switch <branch>",
      "Verify the result: git status --short --branch",
    ],
  ]
}

function detachedSummary(state: DetachedWorktree): string {
  const shortCommit = state.commit.slice(0, 12)
  const operation = state.operation ? ` (${state.operation} in progress)` : ""
  if (state.role === "main") {
    return (
      `The main Git worktree is on a detached HEAD at ${shortCommit}${operation}.\n\n` +
      `Main worktree: ${state.path}\n\n` +
      "Stop is blocked until the main worktree is attached to a branch."
    )
  }
  return (
    `The current Git worktree is on a detached HEAD at ${shortCommit}${operation}.\n\n` +
    `Worktree: ${state.path}\n\n` +
    "Stop is blocked until this worktree is attached to a branch."
  )
}

async function collectDetachedWorktreeStop(
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
  const state = await findDetachedWorktree(cwd)
  if (!state) return null

  const ownership = await resolvePeerHeldFiles(state.path, input.session_id)
  const hold = buildOwnershipHoldReason(ownership)

  return {
    kind: "block",
    summary: detachedSummary(state),
    steps: hold ? [hold] : detachedRecoverySteps(state),
    willNeedPush: false,
    sessionId: input.session_id,
    cwd: state.path,
    taskSubject: state.role === "main" ? "Reattach main worktree HEAD" : "Reattach worktree HEAD",
    taskDesc: `note: ${state.role === "main" ? "main " : ""}worktree ${state.path} detached at ${state.commit}`,
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

function hasOutstandingGitWork(ctx: GitContext, deliveryOnly: boolean): boolean {
  if (deliveryOnly) return hasPendingDelivery(ctx)
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
      "Another active session owns uncommitted changes. A commit is not required to stop. Leave peer files untouched.",
      ctx.ownership.ownership
    ),
  }
}

/**
 * Evaluate git status without blocking.
 * Used by stop-ship-checklist to merge git, CI, and issues into one action plan.
 */
async function collectGitWorkflowStopAfterDetachedCheck(
  input: StopHookInput,
  deliveryOnly = false
): Promise<GitWorkflowCollectResult> {
  const ctx = await resolveGitContext(input)
  if (!ctx) return { kind: "ok" }
  if (!hasOutstandingGitWork(ctx, deliveryOnly)) return satisfiedGitResult(ctx)

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
    action: buildGitStopAction(ctx),
  }
}

export async function collectGitWorkflowStop(
  input: StopHookInput,
  deliveryOnly = false
): Promise<GitWorkflowCollectResult> {
  if (deliveryOnly) return await collectGitWorkflowStopAfterDetachedCheck(input, true)
  const detachedWorktree = await collectDetachedWorktreeStop(input)
  if (detachedWorktree) return detachedWorktree
  return await collectGitWorkflowStopAfterDetachedCheck(input)
}

/** Pulling an otherwise clean branch or repairing another worktree is not idle delivery. */
function hasPendingDelivery(ctx: GitContext): boolean {
  return (
    ctx.hasUncommitted ||
    ctx.gitStatus.ahead > 0 ||
    (ctx.gitStatus.branch !== "(detached)" && hasUnresolvedUpstream(ctx))
  )
}

/** With auto-continue disabled, require only preservation of this session's dirty files. */
async function evaluateUncommittedChanges(input: StopHookInput): Promise<SwizHookOutput> {
  const ctx = await resolveGitContext(input)
  if (!ctx) return {}
  if (!ctx.hasUncommitted) {
    const result = satisfiedGitResult(ctx)
    return result.kind === "ok" && result.context ? { systemMessage: result.context } : {}
  }

  // Omit remote-state prose as well as actions: neither should request a push or pull.
  let reason = buildUncommittedReason(ctx.gitStatus, ctx.upstream, 0)
  let steps: ReturnType<typeof buildGitWorkflowSections>
  if (ctx.ownership.known) {
    reason = appendSessionFileOwnershipContext(reason, ctx.ownership.ownership)
    const [header, subSteps] = buildCommitSteps(input, ctx.ownership.ownership)
    steps = [header, ...subSteps]
  } else {
    steps = [buildOwnershipHoldReason(ctx.ownership)]
  }
  await createSessionTask(
    ctx.sessionId,
    "stop-git-workflow-task-created",
    "Commit uncommitted changes",
    `Commit this session's uncommitted changes in ${ctx.cwd}.`,
    ctx.cwd
  )
  return blockStopObj(`${reason}\n\n${formatActionPlan(steps)}`)
}

async function evaluateDetachedWorktree(input: StopHookInput): Promise<SwizHookOutput | null> {
  const detachedWorktree = await collectDetachedWorktreeStop(input)
  if (detachedWorktree?.kind === "hookOutput") return detachedWorktree.output
  if (detachedWorktree?.kind === "block") {
    await createSessionTask(
      detachedWorktree.sessionId,
      "stop-git-workflow-task-created",
      detachedWorktree.taskSubject,
      detachedWorktree.taskDesc,
      detachedWorktree.cwd
    )
    return blockStopObj(
      `${detachedWorktree.summary}\n\n${formatActionPlan(detachedWorktree.steps)}`
    )
  }
  return null
}

async function evaluateFullGitWorkflow(
  input: StopHookInput,
  deliveryOnly: boolean
): Promise<SwizHookOutput> {
  const detached = deliveryOnly ? null : await evaluateDetachedWorktree(input)
  if (detached) return detached

  const pushShortCircuit = await checkPushCooldownOrInFlight(input)
  if (pushShortCircuit !== null) return pushShortCircuit

  const r = await collectGitWorkflowStopAfterDetachedCheck(input, deliveryOnly)
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
  return withStopAction(blockStopObj(r.summary + formatActionPlan(r.steps)), r.action)
}

/**
 * Main evaluation: check git status and return blocking output or empty object.
 */
export async function evaluateStopGitStatus(input: StopHookInput): Promise<SwizHookOutput> {
  const mode = await stopContinuationModeForHook(input)
  if (mode === "commit") return await evaluateUncommittedChanges(input)
  return await evaluateFullGitWorkflow(input, mode === "delivery")
}
