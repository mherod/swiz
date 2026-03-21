#!/usr/bin/env bun
// PreToolUse hook: Block task updates when the worktree has more than N dirty files.
// Forces a commit boundary before the task plan can be reshaped further.
// Threshold is configurable via `swiz settings set dirty-worktree-threshold <N>`.

import { DEFAULT_DIRTY_WORKTREE_THRESHOLD, resolveNumericSetting } from "../src/settings.ts"
import { allowPreToolUse, denyPreToolUse, getGitStatusV2, isGitRepo } from "./hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

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

  denyPreToolUse(
    `Worktree has ${gitStatus.total} dirty files (threshold: ${threshold}). ` +
      `Commit your current changes before updating the task plan.\n\n` +
      `Recovery path (TaskCreate is NOT blocked by this gate):\n` +
      `  1. Use TaskCreate to create a commit task (unblocked)\n` +
      `  2. Use /commit skill to commit changes\n` +
      `  3. Retry this TaskUpdate after commit\n\n` +
      `Manual alternative: git add . && git commit -m "wip: checkpoint"\n\n` +
      `To adjust: swiz settings set dirty-worktree-threshold <N>`
  )
}

if (import.meta.main) void main()
