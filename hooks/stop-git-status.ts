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

function pushSentinelPath(sessionId: string): string {
  const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, "")
  return `/tmp/stop-git-push-prompted-${safeSession}.flag`
}

async function isPushCooldownActive(
  sessionId: string | undefined,
  cwd: string,
  branch: string
): Promise<boolean> {
  if (!sessionId || sessionId === "null") return false
  const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, "")
  if (!safeSession) return false

  // Sentinel must exist and itself be within the cooldown window. Stale files from
  // prior sessions / test runs must not trigger a false-positive cooldown.
  const sentinelFile = Bun.file(pushSentinelPath(sessionId))
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
  if (!sessionId || sessionId === "null") return
  const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, "")
  if (!safeSession) return
  try {
    await Bun.write(pushSentinelPath(sessionId), "")
  } catch {}
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

  // ── Build the reason ──────────────────────────────────────────────────

  let reason = ""
  const steps: string[] = []

  if (hasUncommitted) {
    const { total, modified, added, deleted, untracked, lines } = parseGitStatus(porcelain)
    const parts: string[] = []
    if (modified > 0) parts.push(`${modified} modified`)
    if (added > 0) parts.push(`${added} added`)
    if (deleted > 0) parts.push(`${deleted} deleted`)
    if (untracked > 0) parts.push(`${untracked} untracked`)
    const summary = parts.join(", ")

    reason += `Uncommitted changes detected: ${summary} (${total} file(s))\n\n`
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

    steps.push(
      skillAdvice(
        "commit",
        "Commit your changes with /commit",
        'Commit your changes:\n  git add .\n  git commit -m "<type>(<scope>): <summary>"'
      )
    )
  } else {
    // No uncommitted changes — report the remote state upfront
    if (behind > 0 && ahead > 0) {
      reason += `Branch '${branch}' has diverged from '${upstream}'.\n`
      reason += `  ${ahead} local commit(s) not yet pushed\n`
      reason += `  ${behind} remote commit(s) not yet pulled\n\n`
    } else if (behind > 0) {
      reason += `Branch '${branch}' is ${behind} commit(s) behind '${upstream}'.\n\n`
    } else {
      reason += `Unpushed commits on branch '${branch}': ${ahead} commit(s) ahead of '${upstream}'.\n\n`
    }
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
  if (ahead > 0 || (hasUncommitted && hasRemote)) {
    const totalAfterCommit = hasUncommitted ? ahead + 1 : ahead
    const pushLabel =
      totalAfterCommit > 0 && ahead > 0
        ? `Push ${ahead} commit(s) to '${upstream}'`
        : `Push your committed changes to '${upstream}'`
    steps.push(
      skillAdvice("push", `${pushLabel} with /push`, `${pushLabel}:\n  git push origin ${branch}`)
    )
  }

  reason += formatActionPlan(steps)

  // ── Mark push as prompted (for cooldown on subsequent stop attempts) ─────
  // Record once so future stops within PUSH_COOLDOWN_MS skip re-blocking for push.
  if (ahead > 0 || (hasUncommitted && hasRemote)) {
    await markPushPrompted(input.session_id)
  }

  // ── Task creation ─────────────────────────────────────────────────────

  const taskSubject =
    hasUncommitted && (ahead > 0 || behind > 0)
      ? "Commit changes and sync with remote"
      : hasUncommitted
        ? "Commit uncommitted changes"
        : behind > 0
          ? "Pull remote changes before pushing"
          : "Push branch to remote"

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
