#!/usr/bin/env bun

// PreToolUse hook: Block task updates when the worktree has more than N dirty files.
// Forces a commit boundary before the task plan can be reshaped further.
// Threshold is configurable via `swiz settings set dirty-worktree-threshold <N>`.

import { runSwizHookAsMain } from "../src/RunSwizHookAsMain.ts"
import type { SwizHookOutput, SwizToolHook } from "../src/SwizHook.ts"
import {
  DEFAULT_DIRTY_WORKTREE_THRESHOLD,
  readProjectSettings,
  resolveNumericSetting,
} from "../src/settings.ts"
import { skillAdvice } from "../src/skill-utils.ts"
import { getDefaultBranch, isDefaultBranch } from "../src/utils/git-utils.ts"
import {
  expandSkillReferences,
  getGitStatusV2,
  git,
  isGitRepo,
  mergeActionPlanIntoTasks,
  preToolUseAllow,
  preToolUseDeny,
} from "../src/utils/hook-utils.ts"
import { type ToolHookInput, toolHookInputSchema } from "./schemas.ts"

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

export async function evaluatePretooluseDirtyWorktreeGate(
  raw: Record<string, unknown>
): Promise<SwizHookOutput> {
  let input: ToolHookInput
  try {
    input = toolHookInputSchema.parse(raw)
  } catch {
    return {}
  }
  const cwd = input.cwd
  if (!cwd) return {}
  if (!(await isGitRepo(cwd))) return {}

  const [gitStatus, threshold] = await Promise.all([
    getGitStatusV2(cwd),
    resolveNumericSetting(cwd, "dirtyWorktreeThreshold", DEFAULT_DIRTY_WORKTREE_THRESHOLD),
  ])
  if (!gitStatus) return {}

  if (gitStatus.total === 0) {
    return {}
  }

  if (gitStatus.total <= threshold) {
    const branchHint = await featureBranchHint(cwd)
    const msg = `Worktree has ${gitStatus.total} dirty file(s) (threshold: ${threshold})`
    return preToolUseAllow(branchHint ? `${msg}\n\n${branchHint}` : msg)
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

  return preToolUseDeny(
    `Worktree has ${gitStatus.total} dirty files (threshold: ${threshold}). ` +
      `Commit your current changes before updating the task plan.\n\n` +
      `To adjust: swiz settings set dirty-worktree-threshold <N>`
  )
}

const pretooluseDirtyWorktreeGate: SwizToolHook = {
  name: "pretooluse-dirty-worktree-gate",
  event: "preToolUse",
  timeout: 5,
  cooldownSeconds: 60,

  async run(input) {
    return await evaluatePretooluseDirtyWorktreeGate(input as Record<string, unknown>)
  },
}

export default pretooluseDirtyWorktreeGate

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseDirtyWorktreeGate)
}
