#!/usr/bin/env bun

/**
 * PreToolUse hook: When project trunk mode is enabled, block the `EnterWorktree`
 * tool. Worktrees isolate feature branch work, which conflicts with trunk-based
 * development where all work stays on the default branch.
 *
 * Dual-mode: SwizToolHook + runSwizHookAsMain.
 */

import { runSwizHookAsMain, type SwizHookOutput, type SwizToolHook } from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"
import { readProjectSettings } from "../src/settings.ts"
import { preToolUseDeny } from "../src/utils/hook-utils.ts"

export async function evaluatePretooluseTrunkModeWorktree(input: unknown): Promise<SwizHookOutput> {
  const hookInput = toolHookInputSchema.parse(input)
  const toolName = hookInput.tool_name ?? ""

  if (toolName !== "EnterWorktree") return {}

  const cwd: string = hookInput.cwd ?? process.cwd()
  const project = await readProjectSettings(cwd)
  if (!project?.trunkMode) return {}

  return preToolUseDeny(
    `Trunk mode is enabled — entering a git worktree is not allowed.\n\n` +
      `Worktrees are designed for isolated feature branch work, which conflicts with trunk-based development.\n` +
      `In trunk mode, all work stays on the default branch in your main working directory.`
  )
}

const pretooluseTrunkModeWorktree: SwizToolHook = {
  name: "pretooluse-trunk-mode-worktree",
  event: "preToolUse",
  matcher: "EnterWorktree",
  timeout: 5,
  run(input) {
    return evaluatePretooluseTrunkModeWorktree(input)
  },
}

export default pretooluseTrunkModeWorktree

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseTrunkModeWorktree)
}
