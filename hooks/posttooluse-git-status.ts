#!/usr/bin/env bun
// PostToolUse hook: Inject git status context after every tool call
//
// Dual-mode: exports a SwizHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { runSwizHookAsMain, type SwizHook, type SwizHookOutput } from "../src/SwizHook.ts"
import { buildGitContextLine } from "../src/utils/git-utils.ts"
import type { ToolHookInput } from "./schemas.ts"

/** @deprecated Import from `src/utils/git-utils.ts` or `hook-utils` re-exports. */
export { buildGitContextLine }

const posttoolusGitStatus: SwizHook<ToolHookInput> = {
  name: "posttooluse-git-status",
  event: "postToolUse",
  cooldownSeconds: 60,
  cooldownMode: "always",
  timeout: 5,

  async run(input: ToolHookInput): Promise<SwizHookOutput> {
    const cwd = input.cwd
    if (!cwd) return {}

    const {
      buildContextHookOutput,
      isGitRepo,
      getGitStatusV2,
      getEffectiveSwizSettingsForToolHook,
      fetchGitStatusFromDaemon,
    } = await import("../src/utils/hook-utils.ts")
    if (!(await isGitRepo(cwd))) return {}

    const gitStatus = (await fetchGitStatusFromDaemon(cwd)) ?? (await getGitStatusV2(cwd))
    if (!gitStatus) return {}

    const effective = await getEffectiveSwizSettingsForToolHook({
      cwd,
      session_id: input.session_id,
      payload: input as Record<string, unknown>,
    })
    const status = buildGitContextLine(gitStatus, effective.collaborationMode)
    return buildContextHookOutput("PostToolUse", status)
  },
}

export default posttoolusGitStatus

if (import.meta.main) {
  await runSwizHookAsMain(posttoolusGitStatus)
}
