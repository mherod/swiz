#!/usr/bin/env bun
// Stop hook: Block stop if git repository has uncommitted changes or unpushed commits.
// Combines both checks into one cohesive action plan so the agent sees the full
// commit → pull → push workflow in a single message.
//
// Push cooldown: if we've already prompted the agent to push in this session AND
// the last remote commit is within PUSH_COOLDOWN_MS, skip the push block.
// Uncommitted changes are always enforced regardless of cooldown.

import {
  blockStop,
  createSessionTask,
  formatActionPlan,
  getGitAheadBehind,
  git,
  isGitRepo,
  parseGitStatus,
  type StopHookInput,
  skillAdvice,
} from "./hook-utils.ts"

const PUSH_COOLDOWN_MS = 10 * 60 * 1000 // 10 minutes

/** Returns a filesystem-safe session identifier, or null if the session is invalid/missing. */
function sanitizeSessionId(sessionId: string | undefined): string | null {
  if (!sessionId || sessionId === "null") return null
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "")
  return safe || null
}

function pushSentinelPath(safeSession: string): string {
  return `/tmp/stop-git-push-prompted-${safeSession}.flag`
}

async function isPushCooldownActive(
  sessionId: string | undefined,
  cwd: string,
  branch: string
): Promise<boolean> {
  const safeSession = sanitizeSessionId(sessionId)
  if (!safeSession) return false

  // Sentinel must exist and itself be within the cooldown window. Stale files from
  // prior sessions / test runs must not trigger a false-positive cooldown.
  const sentinelFile = Bun.file(pushSentinelPath(safeSession))
  if (!(await sentinelFile.exists())) return false
  const sentinelMtime = (await sentinelFile.stat()).mtime.getTime()
  if (Date.now() - sentinelMtime > PUSH_COOLDOWN_MS) return false

  // Remote branch must also have been updated within the cooldown window
  const rawTime = await git(["log", "-1", "--format=%ct", `origin/${branch}`], cwd)
  const remoteCommitTime = parseInt(rawTime, 10)
  if (Number.isNaN(remoteCommitTime)) return false

  return Date.now() - remoteCommitTime * 1000 < PUSH_COOLDOWN_MS
}

async function markPushPrompted(sessionId: string | undefined): Promise<void> {
  const safeSession = sanitizeSessionId(sessionId)
  if (!safeSession) return
  try {
    await Bun.write(pushSentinelPath(safeSession), "")
  } catch {}
}

function buildUncommittedReason(
  porcelain: string,
  branch: string,
  upstream: string,
  behind: number
): string {
  const { total, modified, added, deleted, untracked, lines } = parseGitStatus(porcelain)

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
  const input = (await Bun.stdin.json()) as StopHookInput
  const cwd = input.cwd

  if (!(await isGitRepo(cwd))) return

  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return // detached HEAD — nothing sensible to report

  // Run status and remote check in parallel
  const [porcelain, remoteUrl] = await Promise.all([
    git(["status", "--porcelain"], cwd),
    git(["remote", "get-url", "origin"], cwd),
  ])

  const hasUncommitted = !!porcelain
  const hasRemote = !!remoteUrl

  // Fetch ahead/behind only when a remote tracking branch exists
  const aheadBehind = hasRemote ? await getGitAheadBehind(cwd) : null
  const ahead = aheadBehind?.ahead ?? 0
  const behind = aheadBehind?.behind ?? 0
  const upstream = aheadBehind?.upstream ?? `origin/${branch}`

  // Nothing to report
  if (!hasUncommitted && ahead === 0 && behind === 0) return

  // Push-only cooldown: skip push enforcement if we already prompted this session
  // and the remote was updated recently (≤ 10 min). Still enforce uncommitted changes.
  if (!hasUncommitted && behind === 0 && ahead > 0) {
    if (await isPushCooldownActive(input.session_id, cwd, branch)) return
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

      // Walk our process ancestry to exclude inherited git push processes
      const ancestors = new Set<number>()
      let cur = process.ppid
      for (let i = 0; i < 20 && cur > 1; i++) {
        ancestors.add(cur)
        const psProc = Bun.spawn(["ps", "-p", cur.toString(), "-o", "ppid="], {
          stdout: "pipe",
          stderr: "pipe",
        })
        const psOut = await new Response(psProc.stdout).text()
        await psProc.exited
        const ppid = parseInt(psOut.trim(), 10)
        if (isNaN(ppid) || ppid === cur) break
        cur = ppid
      }

      // Get our git root so we only react to pushes within this repo
      const gitRoot = await git(["rev-parse", "--show-toplevel"], cwd)

      // Filter candidates: non-ancestor, and CWD is within our git root
      const nonAncestorPids = pushPids.filter((pid) => !ancestors.has(pid))
      let hasBackgroundPush = false
      for (const pid of nonAncestorPids) {
        const lsofProc = Bun.spawn(["lsof", "-p", pid.toString(), "-d", "cwd", "-Fn"], {
          stdout: "pipe",
          stderr: "pipe",
        })
        const lsofOut = await new Response(lsofProc.stdout).text()
        await lsofProc.exited
        const procCwd = lsofOut
          .split("\n")
          .find((l) => l.startsWith("n"))
          ?.slice(1)
        if (procCwd && gitRoot && procCwd.startsWith(gitRoot)) {
          hasBackgroundPush = true
          break
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
    ? buildUncommittedReason(porcelain, branch, upstream, behind)
    : describeRemoteState(branch, upstream, ahead, behind)

  if (hasUncommitted) {
    steps.push(
      skillAdvice(
        "commit",
        "Commit your changes with /commit",
        'Commit your changes:\n  git add .\n  git commit -m "<type>(<scope>): <summary>"'
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
      skillAdvice("push", `${pushLabel} with /push`, `${pushLabel}:\n  git push origin ${branch}`)
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
