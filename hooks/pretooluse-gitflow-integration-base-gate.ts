#!/usr/bin/env bun

/**
 * PreToolUse hook: Protect git-flow integration base selection.
 * When a repository uses git-flow (has origin/dev or origin/develop),
 * block creating feature branches from main or syncing with main for ordinary feature work.
 * Allow explicit hotfix, release, backport, and production workflows.
 *
 * Dual-mode: SwizToolHook + runSwizHookAsMain.
 */

import { runSwizHookAsMain, type SwizHookOutput, type SwizToolHook } from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"
import { getDefaultBranch } from "../src/utils/git-utils.ts"
import {
  isShellTool,
  preToolUseAllow,
  preToolUseDeny,
  type ToolHookInput,
} from "../src/utils/hook-utils.ts"

// Detect commands that create or fetch from main/default branch
const GIT_FETCH_FROM_MAIN_RE = /\bgit\s+(?:pull|fetch)\s+(?:origin\s+)?main\b/
const GIT_BRANCH_FROM_MAIN_RE =
  /\bgit\s+(?:checkout\s+-[bB]|branch)\s+(?:\S+\s+)?(?:origin\/)?main\b/
const GIT_CHECKOUT_TO_MAIN_RE = /\bgit\s+(?:checkout|switch)\s+(?:origin\/)?main\b(?!\s+-[bB])/

// Keywords that indicate hotfix, release, or production workflows
const HOTFIX_RELEASE_KEYWORDS_RE =
  /\b(?:hotfix|release|production|backport|emergency|critical|patch)\b/i

interface GitFlowContext {
  hasDevBranch: boolean
  hasDevlopBranch: boolean
  integrationBase: string
  isGitFlowRepo: boolean
}

async function detectGitFlowRepo(cwd: string): Promise<GitFlowContext> {
  try {
    // Check for dev or develop branches by looking at ref files directly
    const gitDir = `${cwd}/.git`
    const devRefPath = `${gitDir}/refs/remotes/origin/dev`
    const developRefPath = `${gitDir}/refs/remotes/origin/develop`

    const hasDevBranch = await Bun.file(devRefPath).exists()
    const hasDevlopBranch = await Bun.file(developRefPath).exists()
    const isGitFlowRepo = hasDevBranch || hasDevlopBranch
    const defaultBranch = await getDefaultBranch(cwd)
    const integrationBase = hasDevBranch ? "dev" : hasDevlopBranch ? "develop" : defaultBranch

    return {
      hasDevBranch,
      hasDevlopBranch,
      integrationBase,
      isGitFlowRepo,
    }
  } catch {
    return {
      hasDevBranch: false,
      hasDevlopBranch: false,
      integrationBase: await getDefaultBranch(cwd),
      isGitFlowRepo: false,
    }
  }
}

function isHotfixOrReleaseIntent(transcript: string): boolean {
  return HOTFIX_RELEASE_KEYWORDS_RE.test(transcript)
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

export async function evaluateGitFlowGate(input: unknown): Promise<SwizHookOutput> {
  const hookInput = toolHookInputSchema.parse(input) as ToolHookInput
  const { toolName, command, cwd } = extractInputDetails(hookInput)

  // Only applies to shell commands
  if (!isShellTool(toolName)) return {}

  // Check if command tries to interact with main branch
  const isFetchFromMain = GIT_FETCH_FROM_MAIN_RE.test(command)
  const isBranchFromMain = GIT_BRANCH_FROM_MAIN_RE.test(command)
  const isCheckoutToMain = GIT_CHECKOUT_TO_MAIN_RE.test(command)

  if (!isFetchFromMain && !isBranchFromMain && !isCheckoutToMain) {
    return {}
  }

  // Check git-flow topology
  const gitFlow = await detectGitFlowRepo(cwd)
  if (!gitFlow.isGitFlowRepo) {
    // Not a git-flow repo, allow trunk-based workflow
    return preToolUseAllow(
      `Trunk-based repository: ${command.substring(0, 50)}... is allowed (no dev/develop branch detected).`
    )
  }

  // Get transcript to check for hotfix/release intent
  const transcript = hookInput.transcript_path
    ? await Bun.file(hookInput.transcript_path)
        .text()
        .catch(() => "")
    : ""

  if (isHotfixOrReleaseIntent(transcript)) {
    return preToolUseAllow(
      `Hotfix/release workflow detected in transcript: ${command.substring(0, 50)}... is allowed.`
    )
  }

  // Block main interaction in git-flow for ordinary feature work
  return preToolUseDeny(`
Git-flow repository detected — \`${gitFlow.integrationBase}\` is the integration base.

Attempting: ${command.substring(0, 60)}...

For ordinary feature work, branch from and merge into \`${gitFlow.integrationBase}\`, not \`main\`.

\`\`\`bash
git checkout -b feat/your-feature origin/${gitFlow.integrationBase}
\`\`\`

\`main\` is reserved for hotfixes, releases, and production work.
If this is a hotfix or release, mention "hotfix", "release", or "production" in your workflow description.
`)
}

const pretooluseGitFlowIntegrationBaseGate: SwizToolHook = {
  name: "pretooluse-gitflow-integration-base-gate",
  event: "preToolUse",
  timeout: 10,
  run(input) {
    return evaluateGitFlowGate(input)
  },
}

export default pretooluseGitFlowIntegrationBaseGate

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseGitFlowIntegrationBaseGate)
}
