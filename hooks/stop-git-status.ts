#!/usr/bin/env bun
// Stop hook: Block stop if git repository has uncommitted changes or unpushed commits.
// Combines both checks into one cohesive action plan so the agent sees the full
// commit → pull → push workflow in a single message.
//
// Push cooldown: if we've already prompted the agent to push in this session AND
// the last remote commit is within PUSH_COOLDOWN_MS, skip the push block.
// Uncommitted changes are always enforced regardless of cooldown.

import { getEffectiveSwizSettings, readSwizSettings } from "../src/settings.ts"
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

async function main(): Promise<void> {
  const input = stopHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return

  // Respect the gitStatusGate setting — allow bypassing the hook
  const settings = await readSwizSettings()
  const effective = getEffectiveSwizSettings(settings, input.session_id)
  if (!effective.gitStatusGate) return

  // Single subprocess replaces: branch --show-current, status --porcelain,
  // rev-parse @{upstream}, rev-list x2. Remote URL check is still separate
  // because porcelain=v2 --branch does not expose the remote fetch URL.
  const [gitStatus, remoteUrl] = await Promise.all([
    getGitStatusV2(cwd),
    git(["remote", "get-url", "origin"], cwd),
  ])

  if (!gitStatus) return
  const { branch, ahead, behind } = gitStatus
  if (!branch || branch === "(detached)") return // detached HEAD — nothing sensible to report

  const hasUncommitted = gitStatus.total > 0
  const hasRemote = !!remoteUrl
  const upstream = gitStatus.upstream ?? `origin/${branch}`

  // Nothing to report
  if (!hasUncommitted && ahead === 0 && behind === 0) return

  // Push-only cooldown: skip push enforcement if we already prompted this session
  // and the cooldown is still active. Still enforce uncommitted changes.
  if (!hasUncommitted && behind === 0 && ahead > 0) {
    if (await isPushCooldownActive(input.session_id, cwd, branch, effective.pushCooldownMinutes))
      return
  }

  // In-flight push guard: if a background `git push` is currently running in THIS
  // repository, defer the unpushed-commits block rather than emitting a false positive.
  // Only applies when the sole issue is unpushed commits (no uncommitted changes,
  // not behind). Once the push exits the next stop attempt will re-evaluate correctly.
  //
  // Two-stage filter:
  //   1. Ancestry-aware: exclude git push processes that are ancestors of this process
  //      (e.g., the pre-push hook running bun test during push verification).
  //   2. Repo-aware: exclude git push processes whose CWD is outside our git repo root,
  //      so a push in an unrelated repo doesn't trigger a false positive here.
  if (!hasUncommitted && ahead > 0 && behind === 0) {
    const pgrepProc = Bun.spawn(["pgrep", "-f", "git push"], { stdout: "pipe", stderr: "pipe" })
    const pgrepOut = await new Response(pgrepProc.stdout).text()
    await pgrepProc.exited
    if (pgrepProc.exitCode === 0) {
      const pushPids = pgrepOut.trim().split("\n").map(Number).filter(Boolean)

      // Build the full PID→PPID map with one `ps -eo pid,ppid` call, then walk
      // ancestry in-memory. This replaces up to 20 individual `ps -p <pid>` spawns
      // (each ~20–50 ms) with a single subprocess invocation (~50 ms total).
      const psAllProc = Bun.spawn(["ps", "-eo", "pid,ppid"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const psAllOut = await new Response(psAllProc.stdout).text()
      await psAllProc.exited

      const parentMap = new Map<number, number>()
      for (const line of psAllOut.trim().split("\n").slice(1)) {
        const parts = line.trim().split(/\s+/)
        const pid = parseInt(parts[0] ?? "", 10)
        const ppid = parseInt(parts[1] ?? "", 10)
        if (!Number.isNaN(pid) && !Number.isNaN(ppid)) parentMap.set(pid, ppid)
      }

      const ancestors = new Set<number>()
      let cur = process.ppid
      for (let i = 0; i < 20 && cur > 1; i++) {
        ancestors.add(cur)
        const ppid = parentMap.get(cur)
        if (!ppid || ppid === cur) break
        cur = ppid
      }

      // Get our git root so we only react to pushes within this repo
      const gitRoot = await git(["rev-parse", "--show-toplevel"], cwd)

      // Batch all non-ancestor PIDs into a single lsof call (replaces sequential per-PID fan-out).
      // lsof -p p1,p2,... -d cwd -Fn prints "p<pid>" then "n<cwd>" for each process.
      const nonAncestorPids = pushPids.filter((pid) => !ancestors.has(pid))
      let hasBackgroundPush = false
      if (nonAncestorPids.length > 0) {
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
        if (!lsofKilled && gitRoot) {
          // Each "n<path>" line following a "p<pid>" header is a CWD entry
          for (const line of lsofOut.split("\n")) {
            if (line.startsWith("n") && line.slice(1).startsWith(gitRoot)) {
              hasBackgroundPush = true
              break
            }
          }
        }
      }

      if (hasBackgroundPush) {
        blockStop(
          "A `git push` is currently running in the background.\n\n" +
            "Wait for it to complete before stopping. " +
            "Check the background task output with `TaskOutput <task-id>` to verify it succeeded, " +
            "then try stopping again."
        )
      }
    }
  }

  // ── Build the reason ──────────────────────────────────────────────────

  const steps: string[] = []

  let reason = hasUncommitted
    ? buildUncommittedReason(gitStatus, branch, upstream, behind)
    : describeRemoteState(branch, upstream, ahead, behind)

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

  // Show a push step when: already ahead, or has uncommitted changes and a remote
  // (committing will create at least one new commit to push)
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
        [
          `${pushLabel}:`,
          `  git push origin ${branch}`,
          "",
          "Before pushing — run the collaboration guard:",
          "  Solo repo → direct push to main is permitted.",
          "  Org repo or other contributors active → use a feature branch and PR instead.",
        ].join("\n")
      )
    )
  }

  reason += formatActionPlan(steps)

  // ── Mark push as prompted (for cooldown on subsequent stop attempts) ─────
  // Record once so future stops within PUSH_COOLDOWN_MS skip re-blocking for push.
  if (willNeedPush) {
    await markPushPrompted(input.session_id)
  }

  // ── Task creation ─────────────────────────────────────────────────────

  const taskSubject = selectTaskSubject(hasUncommitted, ahead, behind)
  const taskDesc = [
    hasUncommitted && `Git repository has uncommitted changes at ${cwd}.`,
    behind > 0 && `Branch '${branch}' is ${behind} commit(s) behind '${upstream}'.`,
    ahead > 0 && `Branch has ${ahead} unpushed commit(s) ahead of '${upstream}'.`,
    "Complete the action plan before stopping.",
  ]
    .filter(Boolean)
    .join(" ")

  // Use a single sentinel so the task is created once per session regardless
  // of which state (uncommitted / ahead / behind) triggered the block.
  await createSessionTask(input.session_id, "stop-git-workflow-task-created", taskSubject, taskDesc)

  blockStop(reason)
}

main()
