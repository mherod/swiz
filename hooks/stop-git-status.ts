#!/usr/bin/env bun

// Stop hook: Block stop if git repository has uncommitted changes or unpushed commits.
// Combines both checks into one cohesive action plan so the agent sees the full
// commit → pull → push workflow in a single message.
//
// Push cooldown: if we've already prompted the agent to push in this session AND
// the last remote commit is within PUSH_COOLDOWN_MS, skip the push block.
// Uncommitted changes are always enforced regardless of cooldown.
//
// Dual-mode: exports a SwizStopHook for inline dispatch and remains executable as a subprocess.

import {
  type CollaborationModePolicy,
  getCollaborationModePolicy,
} from "../src/collaboration-policy.ts"
import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import {
  type CollaborationMode,
  getEffectiveSwizSettings,
  readProjectSettings,
  readSwizSettings,
} from "../src/settings.ts"
import { stopGitPushPromptedFlagPath } from "../src/temp-paths.ts"
import {
  type ActionPlanItem,
  blockStopObj,
  createSessionTask,
  formatActionPlan,
  getDefaultBranch,
  getGitStatusV2,
  git,
  isDefaultBranch,
  isGitRepo,
  sanitizeSessionId,
  skillExists,
} from "../src/utils/hook-utils.ts"
import { spawnWithTimeout } from "../src/utils/process-utils.ts"
import { type StopHookInput, stopHookInputSchema } from "./schemas.ts"

const DEFAULT_PUSH_COOLDOWN_MS = 10 * 60 * 1000 // 10 minutes

/** Solo and auto modes never use the team/relaxed feature-branch + PR workflow on main. */
function allowsDirectMainCollaborationWorkflow(mode: CollaborationMode): boolean {
  return mode === "solo" || mode === "auto"
}

function pushSentinelPath(safeSession: string): string {
  return stopGitPushPromptedFlagPath(safeSession)
}

/**
 * Returns true if a push was recently prompted and the cooldown is still active.
 *
 * When `configuredCooldownMinutes > 0` (user-configured), only the sentinel file
 * is checked — the remote-updated check is skipped. This allows the hook to back
 * off during in-flight pushes (pre-push hook running, cooldown window not yet
 * expired) where the remote hasn't been updated yet but the push was started.
 *
 * When `configuredCooldownMinutes === 0` (default / not configured), the built-in
 * 10-minute window is used and BOTH the sentinel AND the remote commit time are
 * checked — matching the original behavior.
 */
async function isPushCooldownActive(
  sessionId: string | undefined,
  cwd: string,
  branch: string,
  configuredCooldownMinutes: number
): Promise<boolean> {
  const safeSession = sanitizeSessionId(sessionId)
  if (!safeSession) return false

  const cooldownMs =
    configuredCooldownMinutes > 0 ? configuredCooldownMinutes * 60 * 1000 : DEFAULT_PUSH_COOLDOWN_MS

  // Sentinel must exist and itself be within the cooldown window. Stale files from
  // prior sessions / test runs must not trigger a false-positive cooldown.
  const sentinelFile = Bun.file(pushSentinelPath(safeSession))
  if (!(await sentinelFile.exists())) return false
  const sentinelMtime = (await sentinelFile.stat()).mtime.getTime()
  if (Date.now() - sentinelMtime > cooldownMs) return false

  // With a user-configured cooldown, sentinel-within-window is sufficient.
  // This supports in-flight pushes where the remote hasn't been updated yet.
  if (configuredCooldownMinutes > 0) return true

  // Default behavior: remote branch must also have been updated within the window.
  const rawTime = await git(["log", "-1", "--format=%ct", `origin/${branch}`], cwd)
  const remoteCommitTime = parseInt(rawTime, 10)
  if (Number.isNaN(remoteCommitTime)) return false

  return Date.now() - remoteCommitTime * 1000 < cooldownMs
}

/** Exported for `stop-ship-checklist` composition. */
export async function markPushPrompted(sessionId: string | undefined): Promise<void> {
  const safeSession = sanitizeSessionId(sessionId)
  if (!safeSession) return
  try {
    await Bun.write(pushSentinelPath(safeSession), "")
  } catch {}
}

function buildUncommittedReason(
  status: {
    total: number
    modified: number
    added: number
    deleted: number
    untracked: number
    lines: string[]
  },
  branch: string,
  upstream: string,
  behind: number
): string {
  const { total, modified, added, deleted, untracked, lines } = status

  const summary = [
    modified > 0 ? `${modified} modified` : "",
    added > 0 ? `${added} added` : "",
    deleted > 0 ? `${deleted} deleted` : "",
    untracked > 0 ? `${untracked} untracked` : "",
  ]
    .filter(Boolean)
    .join(", ")

  let reason = `Uncommitted changes detected: ${summary} (${total} file(s))\n\n`
  reason += "Files with changes:\n"
  reason += lines
    .slice(0, 20)
    .map((l) => `  ${l}`)
    .join("\n")
  if (total > 20) reason += `\n  ... and ${total - 20} more file(s)`
  reason += "\n\n"

  if (behind > 0) {
    reason += `Note: branch '${branch}' is also ${behind} commit(s) behind '${upstream}' — after committing you will need to pull before pushing.\n\n`
  }

  return reason
}

function describeRemoteState(
  branch: string,
  upstream: string,
  ahead: number,
  behind: number
): string {
  if (behind > 0 && ahead > 0) {
    return (
      `Branch '${branch}' has diverged from '${upstream}'.\n` +
      `  ${ahead} local commit(s) not yet pushed\n` +
      `  ${behind} remote commit(s) not yet pulled\n\n`
    )
  }
  if (behind > 0) {
    return `Branch '${branch}' is ${behind} commit(s) behind '${upstream}'.\n\n`
  }
  return `Unpushed commits on branch '${branch}': ${ahead} commit(s) ahead of '${upstream}'.\n\n`
}

function selectTaskSubject(hasUncommitted: boolean, ahead: number, behind: number): string {
  if (hasUncommitted && (ahead > 0 || behind > 0)) return "Commit changes and sync with remote"
  if (hasUncommitted) return "Commit uncommitted changes"
  if (behind > 0) return "Pull remote changes before pushing"
  return "Push branch to remote"
}

function remotePushSubSteps(
  policy: CollaborationModePolicy,
  branch: string,
  onDefaultBranch: boolean,
  trunkMode: boolean,
  defaultBranch: string
): ActionPlanItem[] {
  const steps: ActionPlanItem[] = [`git push origin ${branch}`]
  if (!trunkMode && !onDefaultBranch && policy.requirePullRequest) {
    steps.push(`Open or update a PR: gh pr create --base ${defaultBranch} (if no PR exists)`)
  }
  if (!trunkMode && !onDefaultBranch && policy.requirePeerReview) {
    steps.push("Request a peer review before merging")
  }
  return steps
}

function pushSubStepsForPolicy(
  policy: CollaborationModePolicy,
  branch: string,
  collabMode: CollaborationMode,
  trunkMode: boolean,
  defaultBranch: string
): ActionPlanItem[] {
  const onDefault = isDefaultBranch(branch, defaultBranch)

  if (trunkMode && onDefault) {
    return [`git push origin ${branch}`]
  }

  if (allowsDirectMainCollaborationWorkflow(collabMode)) {
    return remotePushSubSteps(policy, branch, onDefault, trunkMode, defaultBranch)
  }

  // On default branch when direct push is not permitted (team / relaxed-collab)
  if (policy.requireFeatureBranch && onDefault && !trunkMode) {
    const steps: ActionPlanItem[] = [
      "Direct push to the default branch is not permitted — create a feature branch",
      `git checkout -b <type>/<slug>`,
      `git push origin <feature-branch>`,
    ]
    if (policy.requirePullRequest) {
      steps.push(`Open a PR: gh pr create --base ${defaultBranch}`)
    }
    if (policy.requirePeerReview) {
      steps.push("Request a peer review before merging")
    }
    return steps
  }

  return remotePushSubSteps(policy, branch, onDefault, trunkMode, defaultBranch)
}

function buildCommitSteps(): [string, ActionPlanItem[]] {
  const subSteps: ActionPlanItem[] = []
  if (skillExists("commit")) {
    subSteps.push("/commit — Stage and commit with Conventional Commits")
  }
  subSteps.push(
    "git add .",
    'git commit -m "<type>(<scope>): <summary>"',
    "Types: feat, fix, refactor, docs, style, test, chore. Keep summary under 50 characters."
  )
  return ["Commit your changes:", subSteps]
}

function buildPullSteps(): [string, ActionPlanItem[]] {
  const subSteps: ActionPlanItem[] = []
  if (skillExists("resolve-conflicts")) {
    subSteps.push("/resolve-conflicts — Use if conflicts arise during rebase")
  }
  subSteps.push("git pull --rebase --autostash")
  return ["Pull and rebase:", subSteps]
}

interface PushStepParams {
  branch: string
  upstream: string
  ahead: number
  collabMode: CollaborationMode
  trunkMode: boolean
  defaultBranch: string
}

function buildPushSteps(p: PushStepParams): [string, ActionPlanItem[]] {
  const { branch, upstream, ahead, collabMode, trunkMode, defaultBranch } = p
  const policy = getCollaborationModePolicy(collabMode)
  const onDefault = isDefaultBranch(branch, defaultBranch)
  const mainBlocked =
    !trunkMode &&
    policy.requireFeatureBranch &&
    onDefault &&
    !allowsDirectMainCollaborationWorkflow(collabMode)

  const pushHeader = mainBlocked
    ? `Move commits off '${branch}' to a feature branch:`
    : ahead > 0
      ? `Push ${ahead} commit(s) to '${upstream}':`
      : `Push your committed changes to '${upstream}':`
  const subSteps: ActionPlanItem[] = []
  if (skillExists("push")) {
    subSteps.push("/push — Push to remote with collaboration guard")
  }
  subSteps.push(...pushSubStepsForPolicy(policy, branch, collabMode, trunkMode, defaultBranch))
  return [pushHeader, subSteps]
}

function buildGitWorkflowSections(opts: {
  gitStatus: {
    total: number
    modified: number
    added: number
    deleted: number
    untracked: number
    lines: string[]
    branch: string
    upstream: string | null
    ahead: number
    behind: number
  }
  branch: string
  upstream: string
  hasUncommitted: boolean
  hasRemote: boolean
  ahead: number
  behind: number
  collabMode: CollaborationMode
  trunkMode: boolean
  defaultBranch: string
}): { summary: string; steps: ActionPlanItem[] } {
  const {
    gitStatus,
    branch,
    upstream,
    hasUncommitted,
    hasRemote,
    ahead,
    behind,
    collabMode,
    trunkMode,
    defaultBranch,
  } = opts
  const summary = hasUncommitted
    ? buildUncommittedReason(gitStatus, branch, upstream, behind)
    : describeRemoteState(branch, upstream, ahead, behind)

  const steps: ActionPlanItem[] = []

  if (hasUncommitted) steps.push(...buildCommitSteps())
  if (behind > 0) steps.push(...buildPullSteps())
  if (ahead > 0 || (hasUncommitted && hasRemote)) {
    steps.push(...buildPushSteps({ branch, upstream, ahead, collabMode, trunkMode, defaultBranch }))
  }

  return { summary, steps }
}

function buildTaskDesc(opts: {
  cwd: string
  hasUncommitted: boolean
  branch: string
  upstream: string
  behind: number
  ahead: number
}): string {
  const { cwd, hasUncommitted, branch, upstream, behind, ahead } = opts
  return [
    hasUncommitted && `Git repository has uncommitted changes at ${cwd}.`,
    behind > 0 && `Branch '${branch}' is ${behind} commit(s) behind '${upstream}'.`,
    ahead > 0 && `Branch has ${ahead} unpushed commit(s) ahead of '${upstream}'.`,
    "Complete the action plan before stopping.",
  ]
    .filter(Boolean)
    .join(" ")
}

interface ParentMap {
  get(pid: number): number | undefined
}

function buildParentMap(psAllOut: string): ParentMap {
  const parentMap = new Map<number, number>()
  for (const line of psAllOut.trim().split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/)
    const pid = parseInt(parts[0] ?? "", 10)
    const ppid = parseInt(parts[1] ?? "", 10)
    if (!Number.isNaN(pid) && !Number.isNaN(ppid)) parentMap.set(pid, ppid)
  }
  return parentMap
}

function collectAncestors(parentMap: ParentMap, startPpid: number): Set<number> {
  const ancestors = new Set<number>()
  let cur = startPpid
  for (let i = 0; i < 20 && cur > 1; i++) {
    ancestors.add(cur)
    const ppid = parentMap.get(cur)
    if (!ppid || ppid === cur) break
    cur = ppid
  }
  return ancestors
}

function checkLsofForRepoPush(lsofOut: string, gitRoot: string): boolean {
  if (!gitRoot) return false
  for (const line of lsofOut.split("\n")) {
    if (line.startsWith("n") && line.slice(1).startsWith(gitRoot)) {
      return true
    }
  }
  return false
}

/** Timeout for process inspection subcommands (pgrep, ps, lsof). */
const PROC_INSPECT_TIMEOUT_MS = 5_000

async function detectBackgroundPush(cwd: string): Promise<boolean> {
  const pgrepResult = await spawnWithTimeout(["pgrep", "-f", "git push"], {
    timeoutMs: PROC_INSPECT_TIMEOUT_MS,
  })
  if (pgrepResult.timedOut || pgrepResult.exitCode !== 0) return false

  const pushPids = pgrepResult.stdout.trim().split("\n").map(Number).filter(Boolean)

  // Parallelize ps and git rev-parse (both independent of pgrep result)
  const [psResult, gitRoot] = await Promise.all([
    spawnWithTimeout(["ps", "-eo", "pid,ppid"], {
      timeoutMs: PROC_INSPECT_TIMEOUT_MS,
    }),
    git(["rev-parse", "--show-toplevel"], cwd),
  ])

  if (psResult.timedOut) return false

  const parentMap = buildParentMap(psResult.stdout)
  const ancestors = collectAncestors(parentMap, process.ppid)

  const nonAncestorPids = pushPids.filter((pid) => !ancestors.has(pid))
  if (nonAncestorPids.length === 0) return false

  const lsofResult = await spawnWithTimeout(
    ["lsof", "-p", nonAncestorPids.join(","), "-d", "cwd", "-Fn"],
    { timeoutMs: PROC_INSPECT_TIMEOUT_MS }
  )

  return !lsofResult.timedOut && checkLsofForRepoPush(lsofResult.stdout, gitRoot)
}

interface GitContext {
  cwd: string
  sessionId: string | undefined
  gitStatus: Awaited<ReturnType<typeof getGitStatusV2>> & { branch: string }
  hasUncommitted: boolean
  hasRemote: boolean
  upstream: string
  collabMode: CollaborationMode
  pushCooldownMinutes: number
  defaultBranch: string
  trunkMode: boolean
}

async function resolveEffectiveSettings(
  input: { _effectiveSettings?: Record<string, any>; session_id?: string },
  cwd: string
): Promise<{
  collaborationMode: CollaborationMode
  pushCooldownMinutes: number
  projectSettings: Awaited<ReturnType<typeof readProjectSettings>>
}> {
  const projectSettings = await readProjectSettings(cwd)
  if (input._effectiveSettings && typeof input._effectiveSettings.collaborationMode === "string") {
    const injected = input._effectiveSettings as {
      collaborationMode: CollaborationMode
      pushCooldownMinutes?: number
    }
    return {
      collaborationMode: injected.collaborationMode,
      pushCooldownMinutes: injected.pushCooldownMinutes ?? 0,
      projectSettings,
    }
  }
  const settings = await readSwizSettings()
  const full = getEffectiveSwizSettings(settings, input.session_id, projectSettings)
  return {
    collaborationMode: full.collaborationMode,
    pushCooldownMinutes: full.pushCooldownMinutes,
    projectSettings,
  }
}

function gitStatusWarrantsStopHook(
  gitStatus: NonNullable<Awaited<ReturnType<typeof getGitStatusV2>>>
): boolean {
  const branch = gitStatus.branch
  if (!branch || branch === "(detached)") return false
  if (gitStatus.total > 0) return true
  return gitStatus.ahead > 0 || gitStatus.behind > 0
}

async function resolveGitContext(input: StopHookInput): Promise<GitContext | null> {
  const cwd = input.cwd ?? process.cwd()
  if (!(await isGitRepo(cwd))) return null

  const effective = await resolveEffectiveSettings(input, cwd)

  const [gitStatus, remoteUrl] = await Promise.all([
    getGitStatusV2(cwd),
    git(["remote", "get-url", "origin"], cwd),
  ])

  if (!gitStatus || !gitStatusWarrantsStopHook(gitStatus)) return null

  const { branch } = gitStatus
  const hasUncommitted = gitStatus.total > 0

  const defaultBranch = await getDefaultBranch(cwd)
  const trunkMode = effective.projectSettings?.trunkMode === true

  return {
    cwd,
    sessionId: input.session_id,
    gitStatus: gitStatus as GitContext["gitStatus"],
    hasUncommitted,
    hasRemote: !!remoteUrl,
    upstream: gitStatus.upstream ?? `origin/${branch}`,
    collabMode: effective.collaborationMode,
    pushCooldownMinutes: effective.pushCooldownMinutes,
    defaultBranch,
    trunkMode,
  }
}

/**
 * Push gating short-circuit for stop.
 * - `null`: no early decision — continue with uncommitted / unpushed enforcement.
 * - `{}`: push cooldown active — allow stop without blocking on unpushed commits.
 * - non-empty: block stop (e.g. background `git push` still running).
 */
async function checkPushCooldownOrInFlight(ctx: GitContext): Promise<SwizHookOutput | null> {
  const {
    hasUncommitted,
    gitStatus: { ahead, behind },
  } = ctx

  if (!hasUncommitted && behind === 0 && ahead > 0) {
    if (
      await isPushCooldownActive(
        ctx.sessionId,
        ctx.cwd,
        ctx.gitStatus.branch,
        ctx.pushCooldownMinutes
      )
    )
      return {}
  }

  if (!hasUncommitted && ahead > 0 && behind === 0) {
    if (await detectBackgroundPush(ctx.cwd)) {
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

/** Result of git workflow gating for composition with other stop checks. */
export type GitWorkflowCollectResult =
  | { kind: "ok" }
  | { kind: "hookOutput"; output: SwizHookOutput }
  | {
      kind: "block"
      summary: string
      steps: ActionPlanItem[]
      willNeedPush: boolean
      sessionId: string | undefined
      cwd: string
      taskSubject: string
      taskDesc: string
    }

/**
 * Evaluate git status / push / pull requirements without emitting a stop response.
 * Used by `stop-ship-checklist` to merge git, CI, and issues into one action plan.
 */
export async function collectGitWorkflowStop(
  input: StopHookInput
): Promise<GitWorkflowCollectResult> {
  const ctx = await resolveGitContext(input)
  if (!ctx) return { kind: "ok" }

  const pushShortCircuit = await checkPushCooldownOrInFlight(ctx)
  if (pushShortCircuit !== null) return { kind: "hookOutput", output: pushShortCircuit }

  const { gitStatus, hasUncommitted, hasRemote, upstream, cwd } = ctx
  const { branch, ahead, behind } = gitStatus

  const { summary, steps } = buildGitWorkflowSections({
    gitStatus,
    branch,
    upstream,
    hasUncommitted,
    hasRemote,
    ahead,
    behind,
    collabMode: ctx.collabMode,
    trunkMode: ctx.trunkMode,
    defaultBranch: ctx.defaultBranch,
  })

  const willNeedPush = ahead > 0 || (hasUncommitted && hasRemote)
  const taskSubject = selectTaskSubject(hasUncommitted, ahead, behind)
  const taskDesc = buildTaskDesc({ cwd, hasUncommitted, branch, upstream, behind, ahead })

  return {
    kind: "block",
    summary,
    steps,
    willNeedPush,
    sessionId: ctx.sessionId,
    cwd,
    taskSubject,
    taskDesc,
  }
}

export async function evaluateStopGitStatus(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  const r = await collectGitWorkflowStop(parsed)
  if (r.kind === "ok") return {}
  if (r.kind === "hookOutput") return r.output

  if (r.willNeedPush) await markPushPrompted(r.sessionId)
  await createSessionTask(r.sessionId, "stop-git-workflow-task-created", r.taskSubject, r.taskDesc)
  return blockStopObj(r.summary + formatActionPlan(r.steps))
}

const stopGitStatus: SwizStopHook = {
  name: "stop-git-status",
  event: "stop",
  timeout: 10,
  requiredSettings: ["gitStatusGate"],

  run(input) {
    return evaluateStopGitStatus(input)
  },
}

export default stopGitStatus

if (import.meta.main) {
  await runSwizHookAsMain(stopGitStatus)
}
