#!/usr/bin/env bun

/**
 * PreToolUse hook: When project trunk mode is enabled, keep the checkout on the
 * configured default branch. Blocks branch/worktree creation and reshaping,
 * switching to non-default branches, `gh pr checkout` outside its active-review
 * exception, and `gh pr create`.
 *
 * Dual-mode: SwizToolHook + runSwizHookAsMain.
 */

import { isGitRepoForHookPayload } from "../src/repository-capability.ts"
import { runSwizHookAsMain, type SwizHookOutput, type SwizToolHook } from "../src/SwizHook.ts"
import { shellHookInputSchema } from "../src/schemas.ts"
import { readProjectSettings, readProjectState } from "../src/settings.ts"
import {
  collectGitBranchChanges,
  collectPlainCheckoutSwitchTargets,
  GIT_CHECKOUT_RE,
  GIT_SWITCH_RE,
  type GitBranchChange,
  getDefaultBranch,
  isDefaultBranch,
} from "../src/utils/git-utils.ts"
import {
  GH_PR_CHECKOUT_RE,
  GH_PR_CREATE_RE,
  ghJson,
  isGitRepo,
  isShellTool,
  preToolUseDeny,
} from "../src/utils/hook-utils.ts"

function isTrunkModeRelevantShellCommand(
  command: string,
  branchChanges: GitBranchChange[]
): boolean {
  return (
    branchChanges.length > 0 ||
    GIT_CHECKOUT_RE.test(command) ||
    GIT_SWITCH_RE.test(command) ||
    GH_PR_CHECKOUT_RE.test(command) ||
    GH_PR_CREATE_RE.test(command)
  )
}

function denyPrCreateWhenTrunk(command: string, defaultBranch: string): SwizHookOutput | null {
  if (!GH_PR_CREATE_RE.test(command)) return null
  return preToolUseDeny(
    `Trunk mode is enabled — opening a new pull request is not allowed.\n\n` +
      `Push directly to the default branch (\`${defaultBranch}\`).`
  )
}

async function queryOpenPullRequests(cwd: string): Promise<boolean> {
  const prs = await ghJson<Array<{ number?: number }>>(
    ["pr", "list", "--state", "open", "--json", "number", "--limit", "1"],
    cwd
  )
  return Array.isArray(prs) && prs.length > 0
}

export interface TrunkModeBranchGateRuntime {
  isGitRepo(cwd: string): Promise<boolean>
  readProjectSettings(cwd: string): Promise<{ trunkMode?: boolean } | null>
  readProjectState(cwd: string): Promise<string | null>
  getDefaultBranch(cwd: string): Promise<string>
  hasOpenPullRequests(cwd: string): Promise<boolean>
}

export interface TrunkModeBranchGateOptions {
  /** Override process, settings, and repository boundaries for deterministic evaluation. */
  runtime?: Partial<TrunkModeBranchGateRuntime>
}

const defaultRuntime: TrunkModeBranchGateRuntime = {
  isGitRepo,
  readProjectSettings,
  readProjectState,
  getDefaultBranch,
  hasOpenPullRequests: queryOpenPullRequests,
}

async function denyPrCheckoutWhenTrunk(
  command: string,
  defaultBranch: string,
  cwd: string,
  projectState: string | null,
  runtime: TrunkModeBranchGateRuntime
): Promise<SwizHookOutput | null> {
  if (!GH_PR_CHECKOUT_RE.test(command)) return null
  if (projectState === "reviewing" && (await runtime.hasOpenPullRequests(cwd))) return null

  if (projectState === "developing") {
    return preToolUseDeny(
      `Trunk mode is enabled and project state is \`developing\` — checking out a pull request branch is not allowed.\n\n` +
        `Stay on the default branch (\`${defaultBranch}\`) while developing.`
    )
  }

  return preToolUseDeny(
    `Trunk mode is enabled for this project — checking out a pull request branch is not allowed.\n\n` +
      `Work on the default branch (\`${defaultBranch}\`) only.`
  )
}

function denyBranchChangesWhenTrunk(
  changes: GitBranchChange[],
  defaultBranch: string
): SwizHookOutput | null {
  for (const change of changes) {
    if (change.kind === "worktree-add") {
      return preToolUseDeny(
        `Trunk mode is enabled — creating a new git worktree is not allowed.\n\n` +
          `Use the main working directory on the default branch '${defaultBranch}'.`
      )
    }

    const target = change.target ? `\n\nAttempted branch: \`${change.target}\`` : ""
    return preToolUseDeny(
      `Trunk mode is enabled — branch ${change.kind} operations are not allowed.` +
        target +
        `\n\nStay on the default branch '${defaultBranch}'.`
    )
  }
  return null
}

function countBranchSwitchCommands(command: string): number {
  const countMatches = (pattern: RegExp): number =>
    Array.from(command.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))).length
  return countMatches(GIT_CHECKOUT_RE) + countMatches(GIT_SWITCH_RE)
}

function denyBranchSwitchesWhenTrunk(
  command: string,
  defaultBranch: string
): SwizHookOutput | null {
  const commandCount = countBranchSwitchCommands(command)
  if (commandCount === 0) return null

  const targets = collectPlainCheckoutSwitchTargets(command)
  const nonDefaultTarget = targets.find((target) => !isDefaultBranch(target, defaultBranch))
  if (nonDefaultTarget) {
    return preToolUseDeny(
      `Trunk mode is enabled — checking out a non-default branch is not allowed.\n\n` +
        `Attempted branch: '${nonDefaultTarget}'\n\n` +
        `Stay on the default branch '${defaultBranch}'.`
    )
  }

  if (targets.length < commandCount) {
    return preToolUseDeny(
      `Trunk mode is enabled — checkout and switch operations are only allowed when explicitly returning to the default branch '${defaultBranch}'.`
    )
  }

  return null
}

interface TrunkShellRequest {
  command: string
  cwd: string
  toolName: string
  input: Record<string, unknown>
}

function resolveTrunkShellRequest(input: unknown): TrunkShellRequest {
  const hookInput = shellHookInputSchema.parse(input)
  return {
    command: String(hookInput.tool_input?.command ?? "").normalize("NFKC"),
    cwd: hookInput.cwd ?? process.cwd(),
    toolName: hookInput.tool_name ?? "",
    input: hookInput as Record<string, unknown>,
  }
}

async function shouldEnforceTrunkMode(
  request: TrunkShellRequest,
  branchChanges: GitBranchChange[],
  runtime: TrunkModeBranchGateRuntime
): Promise<boolean> {
  if (!isShellTool(request.toolName)) return false
  if (!isTrunkModeRelevantShellCommand(request.command, branchChanges)) return false
  if (!(await isGitRepoForHookPayload(request.input, request.cwd, runtime.isGitRepo))) return false
  return (await runtime.readProjectSettings(request.cwd))?.trunkMode === true
}

async function selectTrunkModeDenial(
  request: TrunkShellRequest,
  branchChanges: GitBranchChange[],
  defaultBranch: string,
  projectState: string | null,
  runtime: TrunkModeBranchGateRuntime
): Promise<SwizHookOutput | null> {
  const prCreate = denyPrCreateWhenTrunk(request.command, defaultBranch)
  if (prCreate) return prCreate

  const prCheckout = await denyPrCheckoutWhenTrunk(
    request.command,
    defaultBranch,
    request.cwd,
    projectState,
    runtime
  )
  return (
    prCheckout ??
    denyBranchChangesWhenTrunk(branchChanges, defaultBranch) ??
    denyBranchSwitchesWhenTrunk(request.command, defaultBranch)
  )
}

export async function evaluatePretooluseTrunkModeBranchGate(
  input: unknown,
  options: TrunkModeBranchGateOptions = {}
): Promise<SwizHookOutput> {
  const runtime = { ...defaultRuntime, ...options.runtime }
  const request = resolveTrunkShellRequest(input)
  const branchChanges = collectGitBranchChanges(request.command)
  if (!(await shouldEnforceTrunkMode(request, branchChanges, runtime))) return {}

  const projectState = await runtime.readProjectState(request.cwd)
  const defaultBranch = await runtime.getDefaultBranch(request.cwd)
  return (
    (await selectTrunkModeDenial(request, branchChanges, defaultBranch, projectState, runtime)) ??
    {}
  )
}

const pretooluseTrunkModeBranchGate: SwizToolHook = {
  name: "pretooluse-trunk-mode-branch-gate",
  event: "preToolUse",
  timeout: 10,
  run(input) {
    return evaluatePretooluseTrunkModeBranchGate(input)
  },
}

export default pretooluseTrunkModeBranchGate

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseTrunkModeBranchGate)
}
