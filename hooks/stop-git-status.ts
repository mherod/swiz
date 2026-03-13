#!/usr/bin/env bun
// Stop hook: Block stop if git repository has uncommitted changes or unpushed commits.
// Combines both checks into one cohesive action plan so the agent sees the full
// commit → pull → push workflow in a single message.
//
// Push cooldown: if we've already prompted the agent to push in this session AND
// the last remote commit is within PUSH_COOLDOWN_MS, skip the push block.
// Uncommitted changes are always enforced regardless of cooldown.

import {
  type CollaborationMode,
  getEffectiveSwizSettings,
  readSwizSettings,
} from "../src/settings.ts"
import { stopGitPushPromptedFlagPath } from "../src/temp-paths.ts"
import {
  blockStop,
  createSessionTask,
  formatActionPlan,
  getGitStatusV2,
  git,
  isGitRepo,
  sanitizeSessionId,
  skillAdvice,
} from "./hook-utils.ts"
import { stopHookInputSchema } from "./schemas.ts"

const DEFAULT_PUSH_COOLDOWN_MS = 10 * 60 * 1000 // 10 minutes

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

async function markPushPrompted(sessionId: string | undefined): Promise<void> {
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

function pushAdviceForMode(
  collabMode: CollaborationMode,
  branch: string,
  upstream: string,
  ahead: number
): string {
  const pushLabel =
    ahead > 0
      ? `Push ${ahead} commit(s) to '${upstream}'`
      : `Push your committed changes to '${upstream}'`

  if (collabMode === "solo") {
    return [`${pushLabel}:`, `  git push origin ${branch}`].join("\n")
  }
  if (collabMode === "team") {
    const isMainBranch = branch === "main" || branch === "master"
    if (isMainBranch) {
      return [
        `${pushLabel}:`,
        `  Create a feature branch first: git checkout -b <type>/<slug>`,
        `  Then push: git push origin <feature-branch>`,
        `  Open a PR: gh pr create --base ${branch}`,
      ].join("\n")
    }
    return [`${pushLabel}:`, `  git push origin ${branch}`].join("\n")
  }
  // "auto" or "relaxed-collab" — show the generic guidance
  return [
    `${pushLabel}:`,
    `  git push origin ${branch}`,
    "",
    "Before pushing — run the collaboration guard:",
    "  Solo repo → direct push to main is permitted.",
    "  Org repo or other contributors active → use a feature branch and PR instead.",
  ].join("\n")
}

function buildReason(opts: {
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
}): string {
  const { gitStatus, branch, upstream, hasUncommitted, hasRemote, ahead, behind, collabMode } = opts
  let reason = hasUncommitted
    ? buildUncommittedReason(gitStatus, branch, upstream, behind)
    : describeRemoteState(branch, upstream, ahead, behind)

  const steps: string[] = []

  if (hasUncommitted) {
    steps.push(
      skillAdvice(
        "commit",
        "Commit your changes with /commit",
        [
          "Commit your changes:",
          "  git add .",
          '  git commit -m "<type>(<scope>): <summary>"',
          "",
          "Commit message types: feat, fix, refactor, docs, style, test, chore",
          "Keep summary under 50 characters. Use present tense. No Co-Authored-By trailers.",
        ].join("\n")
      )
    )
  }

  if (behind > 0) {
    steps.push(
      skillAdvice(
        "resolve-conflicts",
        "Pull and rebase: git pull --rebase --autostash (use /resolve-conflicts if conflicts arise)",
        "Pull and rebase: git pull --rebase --autostash"
      )
    )
  }

  const willNeedPush = ahead > 0 || (hasUncommitted && hasRemote)
  if (willNeedPush) {
    const pushLabel =
      ahead > 0
        ? `Push ${ahead} commit(s) to '${upstream}'`
        : `Push your committed changes to '${upstream}'`
    steps.push(
      skillAdvice(
        "push",
        `${pushLabel} with /push`,
        pushAdviceForMode(collabMode, branch, upstream, ahead)
      )
    )
  }

  reason += formatActionPlan(steps)
  return reason
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

async function detectBackgroundPush(cwd: string): Promise<boolean> {
  const pgrepProc = Bun.spawn(["pgrep", "-f", "git push"], { stdout: "pipe", stderr: "pipe" })
  const pgrepOut = await new Response(pgrepProc.stdout).text()
  await pgrepProc.exited
  if (pgrepProc.exitCode !== 0) return false

  const pushPids = pgrepOut.trim().split("\n").map(Number).filter(Boolean)

  const psAllProc = Bun.spawn(["ps", "-eo", "pid,ppid"], { stdout: "pipe", stderr: "pipe" })
  const psAllOut = await new Response(psAllProc.stdout).text()
  await psAllProc.exited

  const parentMap = buildParentMap(psAllOut)
  const ancestors = collectAncestors(parentMap, process.ppid)
  const gitRoot = await git(["rev-parse", "--show-toplevel"], cwd)

  const nonAncestorPids = pushPids.filter((pid) => !ancestors.has(pid))
  if (nonAncestorPids.length === 0) return false

  const lsofProc = Bun.spawn(["lsof", "-p", nonAncestorPids.join(","), "-d", "cwd", "-Fn"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  let lsofKilled = false
  const killTimer = setTimeout(() => {
    lsofKilled = true
    lsofProc.kill()
  }, 2000)
  const lsofOut = await new Response(lsofProc.stdout).text()
  await lsofProc.exited
  clearTimeout(killTimer)

  return !lsofKilled && checkLsofForRepoPush(lsofOut, gitRoot)
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
}

async function resolveGitContext(input: {
  cwd?: string
  session_id?: string
}): Promise<GitContext | null> {
  const cwd = input.cwd ?? process.cwd()
  if (!(await isGitRepo(cwd))) return null

  const settings = await readSwizSettings()
  const effective = getEffectiveSwizSettings(settings, input.session_id)
  if (!effective.gitStatusGate) return null

  const [gitStatus, remoteUrl] = await Promise.all([
    getGitStatusV2(cwd),
    git(["remote", "get-url", "origin"], cwd),
  ])

  if (!gitStatus) return null
  const { branch, ahead, behind } = gitStatus
  if (!branch || branch === "(detached)") return null

  const hasUncommitted = gitStatus.total > 0
  if (!hasUncommitted && ahead === 0 && behind === 0) return null

  return {
    cwd,
    sessionId: input.session_id,
    gitStatus: gitStatus as GitContext["gitStatus"],
    hasUncommitted,
    hasRemote: !!remoteUrl,
    upstream: gitStatus.upstream ?? `origin/${branch}`,
    collabMode: effective.collaborationMode,
    pushCooldownMinutes: effective.pushCooldownMinutes,
  }
}

async function checkPushCooldownOrInFlight(ctx: GitContext): Promise<boolean> {
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
      return true
  }

  if (!hasUncommitted && ahead > 0 && behind === 0) {
    if (await detectBackgroundPush(ctx.cwd)) {
      blockStop(
        "A `git push` is currently running in the background.\n\n" +
          "Wait for it to complete before stopping. " +
          "Check the background task output with `TaskOutput <task-id>` to verify it succeeded, " +
          "then try stopping again."
      )
    }
  }
  return false
}

async function main(): Promise<void> {
  const input = stopHookInputSchema.parse(await Bun.stdin.json())
  const ctx = await resolveGitContext(input)
  if (!ctx) return

  if (await checkPushCooldownOrInFlight(ctx)) return

  const { gitStatus, hasUncommitted, hasRemote, upstream, cwd } = ctx
  const { branch, ahead, behind } = gitStatus

  const willNeedPush = ahead > 0 || (hasUncommitted && hasRemote)
  const reason = buildReason({
    gitStatus,
    branch,
    upstream,
    hasUncommitted,
    hasRemote,
    ahead,
    behind,
    collabMode: ctx.collabMode,
  })

  if (willNeedPush) await markPushPrompted(ctx.sessionId)

  const taskSubject = selectTaskSubject(hasUncommitted, ahead, behind)
  const taskDesc = buildTaskDesc({ cwd, hasUncommitted, branch, upstream, behind, ahead })
  await createSessionTask(ctx.sessionId, "stop-git-workflow-task-created", taskSubject, taskDesc)

  blockStop(reason)
}

if (import.meta.main) void main()
