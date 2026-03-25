#!/usr/bin/env bun

/**
 * PreToolUse hook: When project trunk mode is enabled, block creating or checking
 * out any branch other than the repository default branch, block `gh pr checkout`,
 * and block `gh pr create` (no new pull requests on trunk).
 *
 * Allows switching to the default branch, detached SHAs, HEAD-relative refs, `.`, `-`,
 * and remote forms like `origin/<default>`.
 */

import { readProjectSettings, readProjectState } from "../src/settings.ts"
import { shellHookInputSchema } from "./schemas.ts"
import {
  collectCheckoutNewBranchNames,
  collectPlainCheckoutSwitchTargets,
  getDefaultBranch,
  isDefaultBranch,
} from "./utils/git-utils.ts"
import {
  denyPreToolUse,
  GH_PR_CHECKOUT_RE,
  GH_PR_CREATE_RE,
  GIT_CHECKOUT_RE,
  GIT_SWITCH_RE,
  ghJson,
  isGitRepo,
  isShellTool,
} from "./utils/hook-utils.ts"

function isAllowedTrunkCheckoutTarget(target: string, defaultBranch: string): boolean {
  if (target === "." || target === "-" || target === "@{-1}") return true
  if (/^[0-9a-f]{7,40}$/i.test(target)) return true
  if (/^HEAD/i.test(target)) return true
  if (isDefaultBranch(target, defaultBranch)) return true
  if (target === `origin/${defaultBranch}`) return true
  if (target === `remotes/origin/${defaultBranch}`) return true
  if (target === `refs/heads/${defaultBranch}`) return true
  return false
}

function isTrunkModeRelevantShellCommand(command: string): boolean {
  return (
    GIT_CHECKOUT_RE.test(command) ||
    GIT_SWITCH_RE.test(command) ||
    GH_PR_CHECKOUT_RE.test(command) ||
    GH_PR_CREATE_RE.test(command)
  )
}

function denyPrCreateWhenTrunk(command: string, defaultBranch: string): void {
  if (!GH_PR_CREATE_RE.test(command)) return
  denyPreToolUse(
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
): Promise<void> {
  if (!GH_PR_CHECKOUT_RE.test(command)) return
  if (projectState === "reviewing" && (await hasOpenPullRequests(cwd))) return

  if (projectState === "developing") {
    denyPreToolUse(
      `Trunk mode is enabled and project state is \`developing\` — checking out a pull request branch is not allowed.\n\n` +
        `Stay on the default branch (\`${defaultBranch}\`) while developing.`
    )
  }

  denyPreToolUse(
    `Trunk mode is enabled for this project — checking out a pull request branch is not allowed.\n\n` +
      `Work on the default branch (\`${defaultBranch}\`) only.`
  )
}

function denyNonDefaultNewBranches(command: string, defaultBranch: string): void {
  for (const name of collectCheckoutNewBranchNames(command)) {
    if (isDefaultBranch(name, defaultBranch)) continue
    denyPreToolUse(
      `Trunk mode is enabled — creating a new branch other than the default branch (\`${defaultBranch}\`) is not allowed.\n\n` +
        `Attempted new branch: \`${name}\`\n\n` +
        `Stay on \`${defaultBranch}\`.`
    )
  }
}

function denyNonDefaultPlainCheckouts(command: string, defaultBranch: string): void {
  for (const target of collectPlainCheckoutSwitchTargets(command)) {
    if (isAllowedTrunkCheckoutTarget(target, defaultBranch)) continue
    denyPreToolUse(
      `Trunk mode is enabled — switching to a branch other than the default (\`${defaultBranch}\`) is not allowed.\n\n` +
        `Attempted ref: \`${target}\`\n\n` +
        `Use \`git checkout ${defaultBranch}\` (or equivalent).`
    )
  }
}

async function main() {
  const input = shellHookInputSchema.parse(await Bun.stdin.json())
  const cwd: string = input.cwd ?? process.cwd()
  const command = String(input.tool_input?.command ?? "")

  if (!isShellTool(input.tool_name ?? "")) process.exit(0)
  if (!isTrunkModeRelevantShellCommand(command)) process.exit(0)
  if (!(await isGitRepo(cwd))) process.exit(0)

  const project = await readProjectSettings(cwd)
  if (!project?.trunkMode) process.exit(0)
  const projectState = await readProjectState(cwd)

  const defaultBranch = await getDefaultBranch(cwd)

  denyPrCreateWhenTrunk(command, defaultBranch)
  await denyPrCheckoutWhenTrunk(command, defaultBranch, cwd, projectState)
  denyNonDefaultNewBranches(command, defaultBranch)
  denyNonDefaultPlainCheckouts(command, defaultBranch)

  process.exit(0)
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Hook error:", e)
    process.exit(1)
  })
}
