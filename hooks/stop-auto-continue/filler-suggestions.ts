/**
 * Deterministic filler next-step suggestions when AI backends are unavailable.
 *
 * Produces context-aware suggestions based on:
 * - Edited file paths from the session
 * - Git status (uncommitted changes, unpushed commits)
 * - Task completion state
 *
 * Reusable by any hook that needs a fallback suggestion without AI.
 */

import { git, isGitRepo } from "../../src/git-helpers.ts"
import { readSessionTasks } from "../../src/tasks/task-recovery.ts"

export interface FillerContext {
  cwd: string
  sessionId?: string
  editedFiles?: string[]
}

interface GitState {
  dirtyCount: number
  unpushedCount: number
  branch: string
}

async function getGitState(cwd: string): Promise<GitState | null> {
  if (!(await isGitRepo(cwd))) return null

  const [status, branch, unpushed] = await Promise.all([
    git(["status", "--porcelain"], cwd).catch(() => ""),
    git(["branch", "--show-current"], cwd).catch(() => "main"),
    git(["rev-list", "--count", "@{upstream}..HEAD"], cwd).catch(() => "0"),
  ])
  const statusText = typeof status === "string" ? status : ""
  const branchText = typeof branch === "string" && branch.trim() ? branch : "main"
  const unpushedText = typeof unpushed === "string" ? unpushed : "0"

  return {
    dirtyCount: statusText.split("\n").filter(Boolean).length,
    unpushedCount: Number.parseInt(unpushedText.trim(), 10) || 0,
    branch: branchText.trim(),
  }
}

async function getIncompleteTasks(sessionId: string): Promise<number> {
  const tasks = await readSessionTasks(sessionId)
  return tasks.filter((t) => t.status === "pending" || t.status === "in_progress").length
}

function suggestFromGitState(gitState: GitState | null): string {
  if (!gitState) return ""
  if (gitState.dirtyCount > 0) {
    return `Commit ${gitState.dirtyCount} uncommitted file(s) before stopping. Use /commit to stage and commit.`
  }
  if (gitState.unpushedCount > 0) {
    return `Push ${gitState.unpushedCount} unpushed commit(s) to origin/${gitState.branch}. Use /push.`
  }
  return ""
}

function suggestFromEditedFiles(editedFiles: string[] | undefined): string {
  if (!editedFiles || editedFiles.length === 0) return ""
  const hasTests = editedFiles.some((f) => /\.test\.|\.spec\./.test(f))
  const hasHooks = editedFiles.some((f) => f.startsWith("hooks/"))
  if (hasHooks && !hasTests) {
    return "Run tests for the edited hook files to verify they work correctly."
  }
  if (editedFiles.length > 5) {
    return "Review the breadth of changes made this session and verify nothing was missed."
  }
  return ""
}

/**
 * Build a deterministic filler next-step suggestion.
 * Returns "" if no useful suggestion can be derived.
 */
export async function buildFillerSuggestion(ctx: FillerContext): Promise<string> {
  const { cwd, sessionId, editedFiles } = ctx

  const gitSuggestion = suggestFromGitState(await getGitState(cwd))
  if (gitSuggestion) return gitSuggestion

  if (sessionId) {
    const incomplete = await getIncompleteTasks(sessionId)
    if (incomplete > 0) return `Complete ${incomplete} remaining task(s) before stopping.`
  }

  return suggestFromEditedFiles(editedFiles)
}
