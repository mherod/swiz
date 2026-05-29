// Follow-up issue-filing + issue-guidance helpers, extracted from hook-utils.ts (issue #678).
// Stop hooks can file follow-up GitHub issues for findings that represent new work
// (not incomplete current work), so a session can stop cleanly while capturing the
// finding as a tracked issue. hook-utils.ts re-exports this module so importers stay unchanged.

import { gh, git, hasGhCli } from "../git-helpers.ts"
import type { HookOutput } from "../schemas.ts"
import { blockStopObj, exitWithHookObject } from "./hook-response.ts"

// Cross-repo issue-guidance text lives in inline-hook-helpers.ts; re-exported here so the
// issue-guidance surface is reachable from one module.
export { buildIssueGuidance } from "./inline-hook-helpers.ts"

export interface FollowUpIssueOptions {
  /** Issue title (required) */
  title: string
  /** Issue body / description */
  body: string
  /** Labels to apply (defaults to ["backlog", "enhancement"]) */
  labels?: string[]
  /** Working directory for gh CLI */
  cwd: string
  /** Session ID for reference in the issue body */
  sessionId?: string | null
}

export type FileFollowUpIssueResult =
  | { status: "blocked"; output: HookOutput }
  | { status: "filed"; issueNum: number | null }

/**
 * Try to file a follow-up GitHub issue. Returns a structured result so SwizHook
 * `run()` can return `output` without `process.exit`; subprocess callers use
 * {@link fileFollowUpIssue} which applies `exitWithHookObject` / `blockStop`.
 */
export async function tryFileFollowUpIssue(
  options: FollowUpIssueOptions,
  blockReason: string
): Promise<FileFollowUpIssueResult> {
  const { title, body, labels = ["backlog", "enhancement"], cwd, sessionId } = options

  if (!hasGhCli()) {
    return {
      status: "blocked",
      output: blockStopObj(
        `${blockReason}\n\n(Could not auto-file follow-up issue: gh CLI unavailable)`
      ),
    }
  }

  const commitSha = await git(["rev-parse", "--short", "HEAD"], cwd)
  const contextLines = [body, "", "---", `Filed automatically by stop hook.`]
  if (commitSha) contextLines.push(`Commit: ${commitSha}`)
  if (sessionId) contextLines.push(`Session: ${sessionId.slice(0, 12)}`)

  const bodyFile = `/tmp/swiz-follow-up-${Date.now()}.md`
  await Bun.write(bodyFile, contextLines.join("\n"))

  try {
    const labelArgs = labels.flatMap((l) => ["--label", l])
    const output = await gh(
      ["issue", "create", "--title", title, "--body-file", bodyFile, ...labelArgs],
      cwd
    )

    const match = output.match(/\/issues\/(\d+)/)
    const issueNum = match?.[1] ? Number.parseInt(match[1], 10) : null

    try {
      await Bun.file(bodyFile).unlink()
    } catch {
      // Best-effort cleanup
    }

    return { status: "filed", issueNum }
  } catch {
    try {
      await Bun.file(bodyFile).unlink()
    } catch {
      // Best-effort cleanup
    }
    return {
      status: "blocked",
      output: blockStopObj(`${blockReason}\n\n(Failed to auto-file follow-up issue)`),
    }
  }
}

/**
 * File a GitHub issue for a follow-up finding and allow stop.
 * Returns the created issue number on success, or null if filing failed.
 * On failure, falls back to blocking stop so the finding is not lost.
 */
export async function fileFollowUpIssue(
  options: FollowUpIssueOptions,
  blockReason: string
): Promise<number | null> {
  const r = await tryFileFollowUpIssue(options, blockReason)
  if (r.status === "blocked") {
    exitWithHookObject(r.output)
  }
  return r.issueNum
}
