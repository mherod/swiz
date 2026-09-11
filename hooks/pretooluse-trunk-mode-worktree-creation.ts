#!/usr/bin/env bun

/**
 * PreToolUse hook: Permit verified existing-ref worktrees in trunk mode.
 * Read-only and cleanup worktree commands remain available.
 *
 * Dual-mode: SwizToolHook + runSwizHookAsMain.
 */

import { isGitRepo } from "../src/git-helpers.ts"
import {
  preToolUseDeny,
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
    if (!(await resolveTrunkGitRepository(invocation, request.cwd, runtime))) continue
    const ref = worktreeCheckoutRef(invocation.args.slice(1))
    if (ref && (await runtime.refExists(invocation, request.cwd, ref))) continue
    return preToolUseDeny(
      `Trunk mode requires an explicit, verified existing ref; no git worktree was created.\n\n` +
        `Reuse an existing local branch without creating or resetting it:\n` +
        `  git worktree add <path> <existing-branch>\n` +
        `  git switch <existing-branch>\n\n` +
        `For a fetched remote PR head, use a detached checkout:\n` +
        `  git worktree add --detach <path> refs/remotes/origin/<existing-PR-branch>\n\n` +
        `Run these commands in the target repository (preserve any git -C options). ` +
        `New/tracking/orphan branches, resets, forced worktrees and implicit ref guessing remain blocked. ` +
        `Git's dirty-checkout and branch-ownership protections still apply.`
    )
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
