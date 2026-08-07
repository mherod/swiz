#!/usr/bin/env bun

/**
 * PreToolUse hook: When project trunk mode is enabled, block the `EnterWorktree`
 * tool. Worktrees isolate feature branch work, which conflicts with trunk-based
 * development where all work stays on the default branch.
 *
 * Dual-mode: SwizToolHook + runSwizHookAsMain.
 */

import {
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHookOutput,
  type SwizToolHook,
} from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"
import { readProjectSettings } from "../src/settings.ts"

export async function evaluatePretooluseTrunkModeWorktree(input: unknown): Promise<SwizHookOutput> {
  const hookInput = toolHookInputSchema.parse(input)
  const toolName = hookInput.tool_name ?? ""

  if (toolName !== "EnterWorktree") return {}

  const cwd: string = hookInput.cwd ?? process.cwd()
  const project = await readProjectSettings(cwd)
  if (!project?.trunkMode) return {}
  const defaultBranch = project.defaultBranch ?? "main"

  return preToolUseDeny(
    `Trunk mode kept work in the current working directory; no git worktree was entered.\n\n` +
      `Continue on trunk:\n` +
      `  git switch ${defaultBranch}\n\n` +
      `If another system moved the repository, use the existing-branch recovery escape hatch:\n` +
      `  git switch <existing-branch>\n\n` +
      `Worktrees remain disabled because this project delivers directly from \`${defaultBranch}\`.`
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
