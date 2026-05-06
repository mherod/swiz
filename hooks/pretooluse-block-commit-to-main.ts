#!/usr/bin/env bun

// PreToolUse hook: Block `git commit` when on the default branch in a collaborative repository.
//
// Dual-mode: SwizToolHook + runSwizHookAsMain.

import { detectProjectCollaborationPolicy } from "../src/collaboration-policy.ts"
import { runSwizHookAsMain, type SwizHookOutput, type SwizToolHook } from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"
import { readProjectSettings } from "../src/settings.ts"
import { getDefaultBranch, isDefaultBranch } from "../src/utils/git-utils.ts"
import {
  detectForkTopology,
  forkPrCreateCmd,
  forkPushCmd,
  GIT_COMMIT_RE,
  git,
  isShellTool,
  preToolUseAllow,
  preToolUseDeny,
  type ToolHookInput,
} from "../src/utils/hook-utils.ts"

async function getBranchInfo(
  cwd: string
): Promise<{ current: string; defaultBranch: string } | null> {
  try {
    const current = (await git(["branch", "--show-current"], cwd)).trim()
    if (!current) return null
    const defaultBranch = await getDefaultBranch(cwd)
    return { current, defaultBranch }
  } catch {
    return null
  }
}

async function checkCollaborationAndDeny(
  cwd: string,
  currentBranch: string,
  defaultBranch: string
): Promise<SwizHookOutput> {
  try {
    const collaboration = await detectProjectCollaborationPolicy(cwd)
    if (!collaboration.isCollaborative) {
      return preToolUseAllow(
        `Continue in solo-repo direct-commit mode: '${currentBranch}' permits direct commits.`
      )
    }

    const signals = collaboration.signals.map((s) => `  - ${s}`).join("\n")
    const owner = collaboration.repoOwner
    const repo = collaboration.repoName
    const repoRef = owner && repo ? `${owner}/${repo}` : "this repository"

    const fork = await detectForkTopology(cwd)

    return preToolUseDeny(`
Committing directly to '${defaultBranch}' is blocked in ${repoRef} (collaborative repository).

Collaboration signals:
${signals}

Use the feature branch workflow instead:
  1. Create a feature branch: git checkout -b feat/description
  2. Commit your changes there
  3. Push: ${forkPushCmd("feat/description", fork)}
  4. Open PR: ${forkPrCreateCmd(defaultBranch, fork)}

This ensures code review and prevents unreviewed changes from landing on the default branch.
`)
  } catch {
    return {}
  }
}

function extractInputDetails(hookInput: ToolHookInput): {
  toolName: string
  command: string
  cwd: string
} {
  return {
    toolName: hookInput.tool_name || "",
    command: (hookInput.tool_input?.command as string) || "",
    cwd: hookInput.cwd || process.cwd(),
  }
}

export async function evaluatePretooluseBlockCommitToMain(input: unknown): Promise<SwizHookOutput> {
  const hookInput = toolHookInputSchema.parse(input) as ToolHookInput
  const { toolName, command, cwd } = extractInputDetails(hookInput)

  if (!isShellTool(toolName)) return {}
  if (!GIT_COMMIT_RE.test(command)) return {}

  const projectSettings = await readProjectSettings(cwd)
  if (projectSettings?.trunkMode) {
    return preToolUseAllow(
      "Continue in trunk-mode commit policy: direct commits to the default branch are allowed."
    )
  }

  const branchInfo = await getBranchInfo(cwd)
  if (!branchInfo) return {}

  const { current: currentBranch, defaultBranch } = branchInfo

  if (!isDefaultBranch(currentBranch, defaultBranch)) {
    return preToolUseAllow(
      `Continue in feature-branch commit mode: '${currentBranch}' is not the default branch '${defaultBranch}'.`
    )
  }

  return await checkCollaborationAndDeny(cwd, currentBranch, defaultBranch)
}

const pretooluseBlockCommitToMain: SwizToolHook = {
  name: "pretooluse-block-commit-to-main",
  event: "preToolUse",
  timeout: 10,
  run(input) {
    return evaluatePretooluseBlockCommitToMain(input)
  },
}

export default pretooluseBlockCommitToMain

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseBlockCommitToMain)
}
