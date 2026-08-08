#!/usr/bin/env bun

/**
 * PreToolUse hook: Block `git worktree add` when project trunk mode is enabled.
 * Read-only and cleanup worktree commands remain available.
 *
 * Dual-mode: SwizToolHook + runSwizHookAsMain.
 */

import { isGitRepo } from "../src/git-helpers.ts"
import { isGitRepoForHookPayload } from "../src/repository-capability.ts"
import {
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHookOutput,
  type SwizToolHook,
} from "../src/SwizHook.ts"
import { shellHookInputSchema } from "../src/schemas.ts"
import { readProjectSettings } from "../src/settings.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { collectGitBranchChanges } from "../src/utils/git-utils.ts"

interface TrunkModeWorktreeCreationSettings {
  defaultBranch?: string
  trunkMode?: boolean
}

export interface TrunkModeWorktreeCreationRuntime {
  isGitRepo(cwd: string): Promise<boolean>
  readProjectSettings(cwd: string): Promise<TrunkModeWorktreeCreationSettings | null>
}

export interface TrunkModeWorktreeCreationOptions {
  runtime?: Partial<TrunkModeWorktreeCreationRuntime>
}

const defaultRuntime: TrunkModeWorktreeCreationRuntime = {
  isGitRepo,
  readProjectSettings,
}

interface WorktreeCreationRequest {
  command: string
  cwd: string
  input: Record<string, unknown>
  toolName: string
}

function requestsWorktreeCreation(command: string): boolean {
  return collectGitBranchChanges(command).some((change) => change.kind === "worktree-add")
}

function resolveWorktreeCreationRequest(input: unknown): WorktreeCreationRequest {
  const hookInput = shellHookInputSchema.parse(input)
  return {
    command: String(hookInput.tool_input?.command ?? "").normalize("NFKC"),
    cwd: hookInput.cwd ?? process.cwd(),
    input: hookInput as Record<string, unknown>,
    toolName: hookInput.tool_name ?? "",
  }
}

function isWorktreeCreationRequest(request: WorktreeCreationRequest): boolean {
  return isShellTool(request.toolName) && requestsWorktreeCreation(request.command)
}

async function resolveTrunkModeSettings(
  request: WorktreeCreationRequest,
  runtime: TrunkModeWorktreeCreationRuntime
): Promise<TrunkModeWorktreeCreationSettings | null> {
  if (!(await isGitRepoForHookPayload(request.input, request.cwd, runtime.isGitRepo))) return null
  const project = await runtime.readProjectSettings(request.cwd)
  return project?.trunkMode ? project : null
}

export async function evaluatePretooluseTrunkModeWorktreeCreation(
  input: unknown,
  options: TrunkModeWorktreeCreationOptions = {}
): Promise<SwizHookOutput> {
  const runtime = { ...defaultRuntime, ...options.runtime }
  const request = resolveWorktreeCreationRequest(input)
  if (!isWorktreeCreationRequest(request)) return {}

  const project = await resolveTrunkModeSettings(request, runtime)
  if (!project) return {}
  const defaultBranch = project.defaultBranch ?? "main"

  return preToolUseDeny(
    `Trunk mode kept work in the current working directory; no git worktree was created.\n\n` +
      `Continue on trunk:\n` +
      `  git switch ${defaultBranch}\n\n` +
      `Existing worktrees can still be inspected or removed with \`git worktree list\` and ` +
      `\`git worktree remove <path>\`.`
  )
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
