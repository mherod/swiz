#!/usr/bin/env bun

// PreToolUse hook: Redirect task directory Bash access to TaskList/TaskGet.

import { runSwizHookAsMain, type SwizHookOutput, type SwizToolHook } from "../src/SwizHook.ts"
import { shellHookInputSchema } from "../src/schemas.ts"
import { preToolUseAllow, preToolUseDeny } from "../src/utils/hook-utils.ts"
import { stripQuotedShellStrings } from "../src/utils/shell-patterns.ts"
import { isProtectedTaskStoragePath } from "./sandbox-path-utils.ts"

const DENY_REASON =
  "Use `TaskList` to see all tasks or `TaskGet` with a task ID to inspect a specific one."

const pretooluseBlockTasksDirBash: SwizToolHook = {
  name: "pretooluse-block-tasks-dir-bash",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 5,

  run(input): SwizHookOutput {
    const parsed = shellHookInputSchema.safeParse(input)
    if (!parsed.success) return preToolUseAllow("")

    const command = parsed.data.tool_input?.command ?? ""
    if (!command) return preToolUseAllow("")

    const stripped = stripQuotedShellStrings(command)

    if (isProtectedTaskStoragePath(command) || isProtectedTaskStoragePath(stripped)) {
      return preToolUseDeny(DENY_REASON)
    }

    return preToolUseAllow("")
  },
}

export default pretooluseBlockTasksDirBash

if (import.meta.main) await runSwizHookAsMain(pretooluseBlockTasksDirBash)
