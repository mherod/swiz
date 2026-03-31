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
import { runSwizHookAsMain, type SwizHook, type SwizHookOutput } from "../src/SwizHook.ts"
import {
  appendBranchProtectionFromStore,
  buildGitRelevantSettingLines,
} from "../src/utils/git-post-tool-directives.ts"
import { buildGitContextLine } from "../src/utils/git-utils.ts"
import type { ToolHookInput } from "./schemas.ts"

/** @deprecated Import from `src/utils/git-utils.ts` or `hook-utils` re-exports. */
export { buildGitContextLine }

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

const posttoolusGitContext: SwizHook<ToolHookInput> = {
  name: "posttooluse-git-context",
  event: "postToolUse",
  cooldownSeconds: 60,
  cooldownMode: "always",
  timeout: 5,

  async run(input: ToolHookInput): Promise<SwizHookOutput> {
    const { tool_name, cwd } = input
    if (!cwd) return {}

    const {
      buildContextHookOutput,
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
      payload: input as Record<string, unknown>,
    })
    const gitStatus = (await fetchGitStatusFromDaemon(cwd)) ?? (await getGitStatusV2(cwd))
    const statusLine = gitStatus ? buildGitContextLine(gitStatus, effective.collaborationMode) : ""
    let directives: string[] = []
    const isGitBash =
      tool_name &&
      isShellTool(tool_name) &&
      GIT_ANY_CMD_RE.test(((input.tool_input as Record<string, unknown>)?.command as string) ?? "")
    if (isGitBash && gitStatus && gitStatus.total > 0) {
      const lines = buildGitRelevantSettingLines(effective)
      const repoSlug = await getRepoSlug(cwd)
      if (gitStatus.branch && repoSlug) {
        const { getIssueStore } = await import("../src/issue-store.ts")
        appendBranchProtectionFromStore(lines, getIssueStore(), repoSlug, gitStatus.branch)
      }

      if (lines.length > 0) {
        const refined = await refineDirectives(lines)
        directives = refined.directives
      }
    }
    const finalContext = [statusLine, ...directives].filter(Boolean).join("\n")
    return finalContext ? buildContextHookOutput("PostToolUse", finalContext) : {}
  },
}

export default posttoolusGitContext

if (import.meta.main) {
  await runSwizHookAsMain(posttoolusGitContext)
}
