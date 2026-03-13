#!/usr/bin/env bun
// PreToolUse hook: Block task updates when the worktree has more than 30 dirty files.
// Forces a commit boundary before the task plan can be reshaped further.

import { denyPreToolUse, getGitStatusV2, isGitRepo } from "./hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

export const DIRTY_FILE_THRESHOLD = 15

async function main(): Promise<void> {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd
  if (!cwd) process.exit(0)
  if (!(await isGitRepo(cwd))) process.exit(0)

  const gitStatus = await getGitStatusV2(cwd)
  if (!gitStatus) process.exit(0)

  if (gitStatus.total <= DIRTY_FILE_THRESHOLD) process.exit(0)

  denyPreToolUse(
    `Worktree has ${gitStatus.total} dirty files (threshold: ${DIRTY_FILE_THRESHOLD}). ` +
      `Commit your current changes before updating the task plan.\n\n` +
      `Run: git add . && git commit -m "wip: checkpoint before task update"\n` +
      `Or use the /commit skill.`
  )
}

if (import.meta.main) void main()
