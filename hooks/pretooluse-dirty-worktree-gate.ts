#!/usr/bin/env bun
// PreToolUse hook: Block task updates when the worktree has more than N dirty files.
// Forces a commit boundary before the task plan can be reshaped further.
// Threshold is configurable via `swiz settings set dirty-worktree-threshold <N>`.

import {
  DEFAULT_DIRTY_WORKTREE_THRESHOLD,
  readProjectSettings,
  resolveNumericSetting,
} from "../src/settings.ts"
import { skillAdvice } from "../src/skill-utils.ts"
import { getDefaultBranch, isDefaultBranch } from "../src/utils/git-utils.ts"
import {
  allowPreToolUse,
  denyPreToolUse,
  expandSkillReferences,
  getGitStatusV2,
  git,
  isGitRepo,
  mergeActionPlanIntoTasks,
} from "../src/utils/hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

/**
 * When on the default branch in a non-trunk-mode project, return advice
 * to move to a feature branch. Returns null when trunk mode is active or
 * when already on a feature branch.
 */
async function featureBranchHint(cwd: string): Promise<string | null> {
  const project = await readProjectSettings(cwd)
  if (project?.trunkMode) return null

  let currentBranch: string
  try {
    currentBranch = (await git(["branch", "--show-current"], cwd)).trim()
  } catch {
    return null
  }
  if (!currentBranch) return null

  let defaultBranch: string
  try {
    defaultBranch = await getDefaultBranch(cwd)
  } catch {
    return null
  }

  if (!isDefaultBranch(currentBranch, defaultBranch)) return null

  return (
    `⚠️ You are committing directly to '${defaultBranch}'. ` +
    `Strongly consider moving to a feature branch first:\n` +
    `  git checkout -b feat/<description>\n` +
    `This keeps the default branch clean and enables code review via PRs.`
  )
}

async function main(): Promise<void> {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd
  if (!cwd) process.exit(0)
  if (!(await isGitRepo(cwd))) process.exit(0)

  const [gitStatus, threshold] = await Promise.all([
    getGitStatusV2(cwd),
    resolveNumericSetting(cwd, "dirtyWorktreeThreshold", DEFAULT_DIRTY_WORKTREE_THRESHOLD),
  ])
  if (!gitStatus) process.exit(0)

  if (gitStatus.total === 0) {
    process.exit(0)
  }

  if (gitStatus.total <= threshold) {
    const branchHint = await featureBranchHint(cwd)
    const msg = `Worktree has ${gitStatus.total} dirty file(s) (threshold: ${threshold})`
    allowPreToolUse(branchHint ? `${msg}\n\n${branchHint}` : msg)
  }

  const commitSteps = await expandSkillReferences([
    skillAdvice(
      "commit",
      "Use /commit skill to commit current changes",
      'Run: git add . && git commit -m "wip: checkpoint"'
    ),
    "Retry this TaskUpdate after commit",
  ])

  if (input.session_id) {
    await mergeActionPlanIntoTasks(commitSteps, input.session_id, cwd)
  }

  denyPreToolUse(
    `Worktree has ${gitStatus.total} dirty files (threshold: ${threshold}). ` +
      `Commit your current changes before updating the task plan.\n\n` +
      `To adjust: swiz settings set dirty-worktree-threshold <N>`
  )
}

if (import.meta.main) void main()
