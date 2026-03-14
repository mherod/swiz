#!/usr/bin/env bun
// PreToolUse hook: Block task updates when the worktree has more than N dirty files.
// Forces a commit boundary before the task plan can be reshaped further.
// Threshold is configurable via `swiz settings set dirty-worktree-threshold <N>`.

import {
  DEFAULT_DIRTY_WORKTREE_THRESHOLD,
  readProjectSettings,
  readSwizSettings,
} from "../src/settings.ts"
import { denyPreToolUse, getGitStatusV2, isGitRepo } from "./hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

/** Resolve threshold: project > global > default (15). */
async function resolveThreshold(cwd: string): Promise<number> {
  const [globalSettings, projectSettings] = await Promise.all([
    readSwizSettings(),
    readProjectSettings(cwd),
  ])
  return (
    projectSettings?.dirtyWorktreeThreshold ??
    globalSettings.dirtyWorktreeThreshold ??
    DEFAULT_DIRTY_WORKTREE_THRESHOLD
  )
}

async function main(): Promise<void> {
  const input = toolHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd
  if (!cwd) process.exit(0)
  if (!(await isGitRepo(cwd))) process.exit(0)

  const [gitStatus, threshold] = await Promise.all([getGitStatusV2(cwd), resolveThreshold(cwd)])
  if (!gitStatus) process.exit(0)

  if (gitStatus.total <= threshold) process.exit(0)

  denyPreToolUse(
    `Worktree has ${gitStatus.total} dirty files (threshold: ${threshold}). ` +
      `Commit your current changes before updating the task plan.\n\n` +
      `Run: git add . && git commit -m "wip: checkpoint before task update"\n` +
      `Or use the /commit skill.\n\n` +
      `To adjust: swiz settings set dirty-worktree-threshold <N>`
  )
}

if (import.meta.main) void main()
