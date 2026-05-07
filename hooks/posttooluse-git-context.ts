#!/usr/bin/env bun

// PostToolUse hook: Inject git status and swiz git settings/branch protection rules.
// 1. Always injects a one-line git status summary (respecting a 60s cooldown).
// 2. After git commands when the worktree is dirty, also injects prescriptive directives
//    based on swiz settings and branch protection.
//
// Dual-mode: exports a SwizHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { z } from "zod"
import { promptObject } from "../src/ai-providers.ts"
import {
  buildSplitContextHookOutput,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import type { ToolHookInput } from "../src/schemas.ts"
import {
  buildBranchStateSystemMessage,
  buildGitContextLine,
  DETACHED_HEAD_WARNING,
} from "../src/utils/git-context-messages.ts"
import {
  appendBranchProtectionFromStore,
  buildGitRelevantSettingLines,
} from "../src/utils/git-post-tool-directives.ts"
import { type GitStatusV2, getUnpushedCommitSummaries } from "../src/utils/git-utils.ts"

/** @deprecated Import from `src/utils/git-utils.ts` or `hook-utils` re-exports. */

async function refineDirectives(lines: string[]): Promise<{
  directives: string[]
}> {
  try {
    return await promptObject(
      `Refine the following into more digestible directives: ${lines.join("\n")}`,
      z.object({
        directives: z.array(z.string()).min(8).max(10),
      })
    )
  } catch {
    return {
      directives: lines || [],
    }
  }
}

async function getGitStatus(
  cwd: string,
  fetchGitStatusFromDaemon: (cwd: string) => Promise<GitStatusV2 | null>,
  getGitStatusV2: (cwd: string) => Promise<GitStatusV2 | null>
) {
  return (await fetchGitStatusFromDaemon(cwd)) ?? (await getGitStatusV2(cwd))
}

function shouldLoadDirectives(
  tool_name: string | undefined,
  input: ToolHookInput,
  gitStatus: GitStatusV2 | null,
  isShellTool: (name: string) => boolean,
  GIT_ANY_CMD_RE: RegExp
): boolean {
  if (!gitStatus || gitStatus.total === 0) return false
  if (!tool_name || !isShellTool(tool_name)) return false
  const command = (input.tool_input as Record<string, any>)?.command as string | undefined
  if (!command) return false
  return GIT_ANY_CMD_RE.test(command)
}

async function loadGitDirectives(
  cwd: string,
  effective: any,
  gitStatus: GitStatusV2,
  getRepoSlug: (cwd: string) => Promise<string | null>
): Promise<string[]> {
  const lines = buildGitRelevantSettingLines(effective)
  const repoSlug = await getRepoSlug(cwd)
  if (gitStatus.branch && repoSlug) {
    const { getIssueStore } = await import("../src/issue-store.ts")
    appendBranchProtectionFromStore(lines, getIssueStore(), repoSlug, gitStatus.branch)
  }

  if (lines.length > 0) {
    const refined = await refineDirectives(lines)
    return refined.directives
  }
  return []
}

async function buildPostToolGitStatusLine(
  cwd: string,
  effective: any,
  gitStatus: GitStatusV2 | null
): Promise<string> {
  if (!gitStatus) return ""
  const unpushedCommitSummaries = gitStatus.ahead > 0 ? await getUnpushedCommitSummaries(cwd) : []
  return buildGitContextLine(
    gitStatus,
    {
      collaborationMode: effective.collaborationMode,
      trunkMode: effective.trunkMode,
      strictNoDirectMain: effective.strictNoDirectMain,
    },
    unpushedCommitSummaries
  )
}

const posttoolusGitContext: SwizHook = {
  name: "posttooluse-git-context",
  event: "postToolUse",
  cooldownSeconds: 60,
  cooldownMode: "always",
  timeout: 5,

  async run(input: ToolHookInput): Promise<SwizHookOutput> {
    const { tool_name, cwd } = input
    if (!cwd) return {}

    const {
      isShellTool,
      getRepoSlug,
      isGitRepo,
      getGitStatusV2,
      GIT_ANY_CMD_RE,
      getEffectiveSwizSettingsForToolHook,
      fetchGitStatusFromDaemon,
    } = await import("../src/utils/hook-utils.ts")

    if (!(await isGitRepo(cwd))) {
      return {}
    }

    const effective = await getEffectiveSwizSettingsForToolHook({
      cwd,
      session_id: input.session_id,
      payload: input as Record<string, any>,
    })
    const gitStatus = await getGitStatus(cwd, fetchGitStatusFromDaemon, getGitStatusV2)
    const statusLine = await buildPostToolGitStatusLine(cwd, effective, gitStatus)

    let directives: string[] = []
    if (shouldLoadDirectives(tool_name, input, gitStatus, isShellTool, GIT_ANY_CMD_RE)) {
      directives = await loadGitDirectives(cwd, effective, gitStatus!, getRepoSlug)
    }

    if (gitStatus?.branch === "(detached)") {
      directives.push(DETACHED_HEAD_WARNING)
    }

    const additionalContext = [statusLine, ...directives].filter(Boolean).join("\n")
    if (!additionalContext) return {}
    const systemMsg = gitStatus ? buildBranchStateSystemMessage(gitStatus, effective) : undefined
    return buildSplitContextHookOutput("PostToolUse", additionalContext, systemMsg)
  },
}

export default posttoolusGitContext

if (import.meta.main) {
  await runSwizHookAsMain(posttoolusGitContext)
}
