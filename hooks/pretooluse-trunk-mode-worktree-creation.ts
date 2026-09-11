#!/usr/bin/env bun

/**
 * PreToolUse hook: Permit verified existing-ref worktrees in trunk mode.
 * Read-only and cleanup worktree commands remain available.
 *
 * Dual-mode: SwizToolHook + runSwizHookAsMain.
 */

import { isGitRepo } from "../src/git-helpers.ts"
import {
  preToolUseDenyWithSystemMessage,
  runSwizHookAsMain,
  type SwizHookOutput,
  type SwizToolHook,
} from "../src/SwizHook.ts"
import { shellHookInputSchema } from "../src/schemas.ts"
import { readProjectSettings } from "../src/settings.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import {
  gitCheckoutRefExists,
  resolveGitRepository,
  resolveTrunkGitRepository,
  worktreeCheckoutRef,
} from "../src/utils/git-checkout.ts"
import { parseGitInvocationTokens, splitShellSegments } from "../src/utils/shell-patterns.ts"
import { trunkModeGuidance } from "../src/utils/trunk-mode-guidance.ts"

interface TrunkModeWorktreeCreationSettings {
  defaultBranch?: string
  trunkMode?: boolean
}

export interface TrunkModeWorktreeCreationRuntime {
  isGitRepo(cwd: string): Promise<boolean>
  readProjectSettings(cwd: string): Promise<TrunkModeWorktreeCreationSettings | null>
  resolveRepository: typeof resolveGitRepository
  refExists: typeof gitCheckoutRefExists
}

export interface TrunkModeWorktreeCreationOptions {
  runtime?: Partial<TrunkModeWorktreeCreationRuntime>
}

const defaultRuntime: TrunkModeWorktreeCreationRuntime = {
  isGitRepo,
  readProjectSettings,
  resolveRepository: resolveGitRepository,
  refExists: gitCheckoutRefExists,
}

interface WorktreeCreationRequest {
  command: string
  cwd: string
  toolName: string
}

function resolveWorktreeCreationRequest(input: unknown): WorktreeCreationRequest {
  const hookInput = shellHookInputSchema.parse(input)
  return {
    command: String(hookInput.tool_input?.command ?? "").normalize("NFKC"),
    cwd: hookInput.cwd ?? process.cwd(),
    toolName: hookInput.tool_name ?? "",
  }
}

async function denyWorktreeCreation(
  cwd: string,
  runtime: TrunkModeWorktreeCreationRuntime
): Promise<SwizHookOutput> {
  const project = await runtime.readProjectSettings(cwd)
  const guidance = trunkModeGuidance(project?.defaultBranch)
  return preToolUseDenyWithSystemMessage(
    `Trunk mode requires an explicit, verified existing ref; no git worktree was created.\n\n` +
      guidance.workflow +
      `\n\n` +
      `Run these commands in the target repository (preserve any git -C options). ` +
      `Branch creation/reset, forced worktrees and implicit ref guessing remain blocked.`,
    guidance.summary
  )
}

export async function evaluatePretooluseTrunkModeWorktreeCreation(
  input: unknown,
  options: TrunkModeWorktreeCreationOptions = {}
): Promise<SwizHookOutput> {
  const runtime = { ...defaultRuntime, ...options.runtime }
  const request = resolveWorktreeCreationRequest(input)
  if (!isShellTool(request.toolName)) return {}
  for (const segment of splitShellSegments(request.command)) {
    const invocation = parseGitInvocationTokens(segment)
    if (invocation?.subcommand !== "worktree" || invocation.args[0] !== "add") continue
    const cwd = await resolveTrunkGitRepository(invocation, request.cwd, runtime)
    if (!cwd) continue
    const ref = worktreeCheckoutRef(invocation.args.slice(1))
    if (ref && (await runtime.refExists(invocation, request.cwd, ref))) continue
    return await denyWorktreeCreation(cwd, runtime)
  }
  return {}
}

const pretooluseTrunkModeWorktreeCreation: SwizToolHook = {
  name: "pretooluse-trunk-mode-worktree-creation",
  event: "preToolUse",
  timeout: 5,
  run(input) {
    return evaluatePretooluseTrunkModeWorktreeCreation(input)
  },
}

export default pretooluseTrunkModeWorktreeCreation

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseTrunkModeWorktreeCreation)
}
