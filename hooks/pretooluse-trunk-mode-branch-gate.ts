#!/usr/bin/env bun

/**
 * PreToolUse hook: When project trunk mode is enabled, block creating or checking
 * out any branch other than the repository default branch, block `gh pr checkout`,
 * and block `gh pr create` (no new pull requests on trunk).
 *
 * Dual-mode: SwizToolHook + runSwizHookAsMain.
 */

import {
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHookOutput,
  type SwizToolHook,
} from "../src/SwizHook.ts"
import { shellHookInputSchema } from "../src/schemas.ts"
import { readProjectSettings, readProjectState } from "../src/settings.ts"
import {
  collectCheckoutNewBranchNames,
  collectPlainCheckoutSwitchTargets,
  getDefaultBranch,
  isDefaultBranch,
} from "../src/utils/git-utils.ts"
import {
  GH_PR_CHECKOUT_RE,
  GH_PR_CREATE_RE,
  GIT_CHECKOUT_RE,
  GIT_SWITCH_RE,
  ghJson,
  isGitRepo,
  isShellTool,
} from "../src/utils/hook-utils.ts"

function isAllowedTrunkCheckoutTarget(target: string, defaultBranch: string): boolean {
  if (target === "." || target === "-" || target === "@{-1}") return true
  if (/^[0-9a-f]{7,40}$/i.test(target)) return true
  if (/^HEAD/i.test(target)) return true
  if (isDefaultBranch(target, defaultBranch)) return true
  if (target === `origin/${defaultBranch}`) return true
  if (target === `remotes/origin/${defaultBranch}`) return true
  return target === `refs/heads/${defaultBranch}`
}

function isTrunkModeRelevantShellCommand(command: string): boolean {
  return (
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

async function hasOpenPullRequests(cwd: string): Promise<boolean> {
  const prs = await ghJson<Array<{ number?: number }>>(
    ["pr", "list", "--state", "open", "--json", "number", "--limit", "1"],
    cwd
  )
  return Array.isArray(prs) && prs.length > 0
}

async function denyPrCheckoutWhenTrunk(
  command: string,
  defaultBranch: string,
  cwd: string,
  projectState: string | null
): Promise<SwizHookOutput | null> {
  if (!GH_PR_CHECKOUT_RE.test(command)) return null
  if (projectState === "reviewing" && (await hasOpenPullRequests(cwd))) return null

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

function denyNonDefaultNewBranches(command: string, defaultBranch: string): SwizHookOutput | null {
  for (const name of collectCheckoutNewBranchNames(command)) {
    if (isDefaultBranch(name, defaultBranch)) continue
    return preToolUseDeny(
      `Trunk mode is enabled — creating a new branch other than the default branch (\`${defaultBranch}\`) is not allowed.\n\n` +
        `Attempted new branch: \`${name}\`\n\n` +
        `Stay on \`${defaultBranch}\`.`
    )
  }
  return null
}

function denyNonDefaultPlainCheckouts(
  command: string,
  defaultBranch: string
): SwizHookOutput | null {
  for (const target of collectPlainCheckoutSwitchTargets(command)) {
    if (isAllowedTrunkCheckoutTarget(target, defaultBranch)) continue
    return preToolUseDeny(
      `Trunk mode is enabled — switching to a branch other than the default (\`${defaultBranch}\`) is not allowed.\n\n` +
        `Attempted ref: \`${target}\`\n\n` +
        `Use \`git checkout ${defaultBranch}\` (or equivalent).`
    )
  }
  return null
}

export async function evaluatePretooluseTrunkModeBranchGate(
  input: unknown
): Promise<SwizHookOutput> {
  const hookInput = shellHookInputSchema.parse(input)
  const cwd: string = hookInput.cwd ?? process.cwd()
  const command = String(hookInput.tool_input?.command ?? "")

  if (!isShellTool(hookInput.tool_name ?? "")) return {}
  if (!isTrunkModeRelevantShellCommand(command)) return {}
  if (!(await isGitRepo(cwd))) return {}

  const project = await readProjectSettings(cwd)
  if (!project?.trunkMode) return {}
  const projectState = await readProjectState(cwd)

  const defaultBranch = await getDefaultBranch(cwd)

  const a = denyPrCreateWhenTrunk(command, defaultBranch)
  if (a) return a
  const b = await denyPrCheckoutWhenTrunk(command, defaultBranch, cwd, projectState)
  if (b) return b
  const c = denyNonDefaultNewBranches(command, defaultBranch)
  if (c) return c
  const d = denyNonDefaultPlainCheckouts(command, defaultBranch)
  if (d) return d

  return {}
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
