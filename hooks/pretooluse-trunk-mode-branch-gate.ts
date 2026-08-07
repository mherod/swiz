#!/usr/bin/env bun

/**
 * PreToolUse hook: When project trunk mode is enabled, allow switching to existing
 * branches as a recovery escape hatch while blocking branch/worktree creation and
 * reshaping. Also blocks `gh pr checkout` outside its active-review exception and
 * blocks `gh pr create`.
 *
 * Dual-mode: SwizToolHook + runSwizHookAsMain.
 */

import { ghJsonViaDaemon as ghJson, isGitRepo } from "../src/git-helpers.ts"
import { isGitRepoForHookPayload } from "../src/repository-capability.ts"
import {
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHookOutput,
  type SwizToolHook,
} from "../src/SwizHook.ts"
import { shellHookInputSchema } from "../src/schemas.ts"
import { readProjectSettings, readProjectState } from "../src/settings.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import {
  collectGitBranchChanges,
  GH_PR_CHECKOUT_RE,
  GH_PR_CREATE_RE,
  type GitBranchChange,
  getDefaultBranch,
} from "../src/utils/git-utils.ts"

function isTrunkModeRelevantShellCommand(
  command: string,
  branchChanges: GitBranchChange[]
): boolean {
  return (
    branchChanges.length > 0 || GH_PR_CHECKOUT_RE.test(command) || GH_PR_CREATE_RE.test(command)
  )
}

function denyPrCreateWhenTrunk(command: string, defaultBranch: string): SwizHookOutput | null {
  if (!GH_PR_CREATE_RE.test(command)) return null
  return preToolUseDeny(
    `Trunk mode kept the repository on its direct-delivery path; no pull request was created.\n\n` +
      `New work lands directly on \`${defaultBranch}\` in this project. Continue with:\n` +
      `  1. Return to trunk: git switch ${defaultBranch}\n` +
      `  2. Commit the completed change on \`${defaultBranch}\`\n` +
      `  3. Push it: git push origin ${defaultBranch}\n\n` +
      `If you meant to finish a pull request that already exists, merge it instead:\n` +
      `  gh pr merge <number>`
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
  if (projectState === "reviewing") {
    if (await runtime.hasOpenPullRequests(cwd)) return null
    return preToolUseDeny(
      `Trunk mode left the working tree unchanged because there is no open pull request to review.\n\n` +
        `Check what is available:\n` +
        `  gh pr list --state open\n\n` +
        `If review work is finished, return to development on trunk:\n` +
        `  swiz state set developing\n` +
        `  git switch ${defaultBranch}`
    )
  }

  if (projectState === "developing") {
    return preToolUseDeny(
      `Trunk mode kept the working tree on \`${defaultBranch}\` because project state is \`developing\`; no pull request branch was checked out.\n\n` +
        `You can continue without switching branches:\n` +
        `  - Inspect the PR: gh pr view <number>\n` +
        `  - Review its patch: gh pr diff <number>\n` +
        `  - Finish a ready PR: gh pr merge <number>\n\n` +
        `If the task is to work directly on an open PR, enter the review workflow first:\n` +
        `  swiz state set reviewing\n` +
        `Then retry \`gh pr checkout <number>\`.`
    )
  }

  return preToolUseDeny(
    `Trunk mode left the working tree on \`${defaultBranch}\`; no pull request branch was checked out.\n\n` +
      `Available paths:\n` +
      `  - Inspect the PR: gh pr view <number>\n` +
      `  - Review its patch: gh pr diff <number>\n` +
      `  - Finish a ready PR: gh pr merge <number>\n` +
      `  - Continue trunk work: git switch ${defaultBranch}\n\n` +
      `For direct work on an open PR, enter the review workflow first:\n` +
      `  swiz state set reviewing\n` +
      `Then retry \`gh pr checkout <number>\`.`
  )
}

function denyBranchChangesWhenTrunk(
  changes: GitBranchChange[],
  defaultBranch: string
): SwizHookOutput | null {
  for (const change of changes) {
    if (change.kind === "worktree-add") {
      return preToolUseDeny(
        `Trunk mode kept work in the main working directory; no git worktree was created.\n\n` +
          `Continue on trunk:\n` +
          `  git switch ${defaultBranch}\n\n` +
          `If another system moved the repository, use the recovery escape hatch instead:\n` +
          `  git switch <existing-branch>`
      )
    }

    const target = change.target ? `\n\nAttempted branch: \`${change.target}\`` : ""
    return preToolUseDeny(
      `Trunk mode left branch state unchanged. No branch was created, copied, renamed, or reset.` +
        target +
        `\n\nContinue on trunk:\n` +
        `  git switch ${defaultBranch}\n\n` +
        `If another system moved the repository, switching to a branch that already exists is the recovery escape hatch:\n` +
        `  git switch <existing-branch>\n\n` +
        `The attempted branch ${change.kind} operation was not applied.`
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
  return prCheckout ?? denyBranchChangesWhenTrunk(branchChanges, defaultBranch)
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
