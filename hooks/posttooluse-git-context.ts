#!/usr/bin/env bun

// PostToolUse hook: Inject swiz git settings and branch protection rules after git commands
// when the worktree has uncommitted changes (dirty workflow). Clean trees stay silent.
// Non-blocking — only emits additionalContext, never denies.
// Uses the SETTINGS_REGISTRY effectExplanation to produce prescriptive directives
// so the agent model is never in doubt about enforced rules.
//
// Dual-mode: exports a SwizHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { runSwizHookAsMain, type SwizHook, type SwizHookOutput } from "../src/SwizHook.ts"
import {
  appendBranchProtectionFromStore,
  buildGitRelevantSettingLines,
} from "../src/utils/git-post-tool-directives.ts"
import type { ToolHookInput } from "./schemas.ts"

const posttoolusGitContext: SwizHook<ToolHookInput> = {
  name: "posttooluse-git-context",
  event: "postToolUse",
  matcher: "Bash",
  timeout: 5,

  async run(input: ToolHookInput): Promise<SwizHookOutput> {
    const { tool_name, cwd } = input
    if (!tool_name || !cwd) return {}

    const {
      buildContextHookOutput,
      isShellTool,
      git,
      getRepoSlug,
      isGitRepo,
      GIT_ANY_CMD_RE,
      getEffectiveSwizSettingsForToolHook,
    } = await import("../src/utils/hook-utils.ts")
    if (!isShellTool(tool_name)) return {}
    const command: string = ((input.tool_input as Record<string, unknown>)?.command as string) ?? ""
    if (!GIT_ANY_CMD_RE.test(command)) return {}
    if (!(await isGitRepo(cwd))) return {}

    const [porcelain, branch, repoSlug] = await Promise.all([
      git(["status", "--porcelain"], cwd),
      git(["branch", "--show-current"], cwd),
      getRepoSlug(cwd),
    ])
    if (!porcelain.trim()) return {}

    const effective = await getEffectiveSwizSettingsForToolHook({
      cwd,
      session_id: input.session_id,
      payload: input as Record<string, unknown>,
    })

    const lines = buildGitRelevantSettingLines(effective)

    if (branch && repoSlug) {
      const { getIssueStore } = await import("../src/issue-store.ts")
      appendBranchProtectionFromStore(lines, getIssueStore(), repoSlug, branch)
    }

    if (lines.length > 0) {
      return buildContextHookOutput("PostToolUse", lines.join("\n"))
    }

    return {}
  },
}

export default posttoolusGitContext

if (import.meta.main) {
  await runSwizHookAsMain(posttoolusGitContext)
}
