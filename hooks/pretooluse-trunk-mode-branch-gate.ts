#!/usr/bin/env bun

/**
 * PreToolUse hook: When project trunk mode is enabled, allow switching to existing
 * branches as a recovery escape hatch while blocking branch creation and reshaping.
 * Also blocks `gh pr checkout` outside its active-review exception and blocks
 * `gh pr create`.
 *
 * Dual-mode: SwizToolHook + runSwizHookAsMain.
 */

import { ghJsonViaDaemon as ghJson, isGitRepo } from "../src/git-helpers.ts"
import { isGitRepoForHookPayload } from "../src/repository-capability.ts"
import {
  preToolUseDeny,
  preToolUseDenyWithSystemMessage,
  runSwizHookAsMain,
  type SwizHookOutput,
  type SwizToolHook,
} from "../src/SwizHook.ts"
import { shellHookInputSchema } from "../src/schemas.ts"
import { readProjectSettings, readProjectState } from "../src/settings.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import {
  checkoutCreatesImplicitBranch,
  resolveGitRepository,
  resolveTrunkGitRepository,
} from "../src/utils/git-checkout.ts"
import {
  collectGitBranchChanges,
  GH_PR_CHECKOUT_RE,
  GH_PR_CREATE_RE,
  type GitBranchChange,
  getDefaultBranch,
} from "../src/utils/git-utils.ts"
import { parseGitInvocationTokens, splitShellSegments } from "../src/utils/shell-patterns.ts"
import { trunkModeGuidance } from "../src/utils/trunk-mode-guidance.ts"

function denyPrCreateWhenTrunk(command: string, defaultBranch: string): SwizHookOutput | null {
  if (!GH_PR_CREATE_RE.test(command)) return null
  const guidance = trunkModeGuidance(defaultBranch)
  return preToolUseDenyWithSystemMessage(
    `Trunk mode kept the repository on its direct-delivery path; no pull request was created.\n\n` +
      guidance.workflow +
      `\n\n` +
      `Finish an existing PR when ready: gh pr merge <number>`,
    guidance.summary
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
  resolveRepository: typeof resolveGitRepository
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
  resolveRepository: resolveGitRepository,
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
    const target = change.target ? `\n\nAttempted branch: \`${change.target}\`` : ""
    const guidance = trunkModeGuidance(defaultBranch)
    return preToolUseDenyWithSystemMessage(
      `Trunk mode left branch state unchanged. No branch was created, copied, renamed, or reset.` +
        target +
        `\n\n` +
        guidance.workflow +
        `\n\n` +
        `The attempted branch ${change.kind} operation was not applied.`,
      guidance.summary
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
  runtime: TrunkModeBranchGateRuntime
): Promise<boolean> {
  if (!isShellTool(request.toolName)) return false
  if (!GH_PR_CHECKOUT_RE.test(request.command) && !GH_PR_CREATE_RE.test(request.command))
    return false
  if (!(await isGitRepoForHookPayload(request.input, request.cwd, runtime.isGitRepo))) return false
  return (await runtime.readProjectSettings(request.cwd))?.trunkMode === true
}

async function selectTrunkModeDenial(
  request: TrunkShellRequest,
  defaultBranch: string,
  projectState: string | null,
  runtime: TrunkModeBranchGateRuntime
): Promise<SwizHookOutput | null> {
  const prCreate = denyPrCreateWhenTrunk(request.command, defaultBranch)
  if (prCreate) return prCreate

  return await denyPrCheckoutWhenTrunk(
    request.command,
    defaultBranch,
    request.cwd,
    projectState,
    runtime
  )
}

export async function evaluatePretooluseTrunkModeBranchGate(
  input: unknown,
  options: TrunkModeBranchGateOptions = {}
): Promise<SwizHookOutput> {
  const runtime = { ...defaultRuntime, ...options.runtime }
  const request = resolveTrunkShellRequest(input)
  if (!isShellTool(request.toolName)) return {}
  const gitDenial = await evaluateGitBranchChanges(request, runtime)
  if (gitDenial) return gitDenial
  if (!(await shouldEnforceTrunkMode(request, runtime))) return {}

  const projectState = await runtime.readProjectState(request.cwd)
  const defaultBranch = await runtime.getDefaultBranch(request.cwd)
  return (await selectTrunkModeDenial(request, defaultBranch, projectState, runtime)) ?? {}
}

async function evaluateGitBranchChanges(
  request: TrunkShellRequest,
  runtime: TrunkModeBranchGateRuntime
): Promise<SwizHookOutput | null> {
  for (const segment of splitShellSegments(request.command)) {
    const invocation = parseGitInvocationTokens(segment)
    if (!invocation || !["branch", "checkout", "switch"].includes(invocation.subcommand)) continue
    const cwd = await resolveTrunkGitRepository(invocation, request.cwd, runtime)
    if (!cwd) continue
    const changes = collectGitBranchChanges(segment)
    if (changes.length === 0 && (await checkoutCreatesImplicitBranch(invocation, request.cwd))) {
      changes.push({ kind: "create", target: null })
    }
    if (changes.length > 0) {
      return denyBranchChangesWhenTrunk(changes, await runtime.getDefaultBranch(cwd))
    }
  }
  return null
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
