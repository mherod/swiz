#!/usr/bin/env bun
// PreToolUse hook: Block task updates when the worktree has more than N dirty files.
// Forces a commit boundary before the task plan can be reshaped further.
// Threshold is configurable via `swiz settings set dirty-worktree-threshold <N>`.

import { DEFAULT_DIRTY_WORKTREE_THRESHOLD, resolveNumericSetting } from "../src/settings.ts"
import { skillAdvice } from "../src/skill-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"
import {
  allowPreToolUse,
  denyPreToolUse,
  expandSkillReferences,
  getGitStatusV2,
  isGitRepo,
  mergeActionPlanIntoTasks,
} from "./utils/hook-utils.ts"

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

  if (gitStatus.total <= threshold) {
    allowPreToolUse(`Worktree has ${gitStatus.total} dirty file(s) (threshold: ${threshold})`)
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
