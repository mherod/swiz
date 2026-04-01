#!/usr/bin/env bun

// PreToolUse hook: Block `git commit` when on the default branch in a collaborative repository.
//
// Dual-mode: SwizToolHook + runSwizHookAsMain.

import { detectProjectCollaborationPolicy } from "../src/collaboration-policy.ts"
import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHookOutput,
  type SwizToolHook,
} from "../src/SwizHook.ts"
import { readProjectSettings } from "../src/settings.ts"
import { getDefaultBranch, isDefaultBranch } from "../src/utils/git-utils.ts"
import {
  detectForkTopology,
  forkPrCreateCmd,
  forkPushCmd,
  GIT_COMMIT_RE,
  git,
  isShellTool,
  type ToolHookInput,
} from "../src/utils/hook-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

export async function evaluatePretooluseBlockCommitToMain(input: unknown): Promise<SwizHookOutput> {
  const hookInput = toolHookInputSchema.parse(input) as ToolHookInput
  if (!isShellTool(hookInput.tool_name ?? "")) return {}

  const command: string = (hookInput.tool_input?.command as string) ?? ""
  const cwd: string = hookInput.cwd ?? process.cwd()

  if (!GIT_COMMIT_RE.test(command)) return {}

  const projectSettings = await readProjectSettings(cwd)
  if (projectSettings?.trunkMode) {
    return preToolUseAllow("Trunk mode enabled — direct commit to default branch allowed")
  }

  let currentBranch: string
  try {
    currentBranch = (await git(["branch", "--show-current"], cwd)).trim()
  } catch {
    return {}
  }

  if (!currentBranch) return {}

  let defaultBranch: string
  try {
    defaultBranch = await getDefaultBranch(cwd)
  } catch {
    return {}
  }

  if (!isDefaultBranch(currentBranch, defaultBranch)) {
    return preToolUseAllow(`On feature branch '${currentBranch}', not default '${defaultBranch}'`)
  }

  let collaboration: Awaited<ReturnType<typeof detectProjectCollaborationPolicy>>
  try {
    collaboration = await detectProjectCollaborationPolicy(cwd)
  } catch {
    return {}
  }

  if (!collaboration.isCollaborative) {
    return preToolUseAllow(`Solo repo — direct commit to '${currentBranch}' allowed`)
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
