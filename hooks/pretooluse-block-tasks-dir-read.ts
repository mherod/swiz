#!/usr/bin/env bun

// PreToolUse hook: Redirect task queries to TaskList/TaskGet tool calls.

import { getHomeDir } from "../src/home.ts"
import { runSwizHookAsMain, type SwizHookOutput, type SwizToolHook } from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"
import { preToolUseAllow, preToolUseDeny } from "../src/utils/hook-utils.ts"

const DENY_REASON =
  "Use `TaskList` to see all tasks or `TaskGet` with a task ID to inspect a specific one."

const pretooluseBlockTasksDirRead: SwizToolHook = {
  name: "pretooluse-block-tasks-dir-read",
  event: "preToolUse",
  matcher: "Read",
  timeout: 5,

  run(input): SwizHookOutput {
    const parsed = toolHookInputSchema.safeParse(input)
    if (!parsed.success) return preToolUseAllow("")

    const filePath: string = (parsed.data as Record<string, any>).tool_input?.file_path ?? ""

    const tasksDir = `${getHomeDir()}/.claude/tasks`
    if (filePath === tasksDir || filePath.startsWith(`${tasksDir}/`)) {
      return preToolUseDeny(DENY_REASON)
    }

    return preToolUseAllow("")
  },
}

export default pretooluseBlockTasksDirRead

if (import.meta.main) await runSwizHookAsMain(pretooluseBlockTasksDirRead)
