#!/usr/bin/env bun

// PreToolUse hook: Redirect task directory Bash access to TaskList/TaskGet.

import { getHomeDir } from "../src/home.ts"
import { runSwizHookAsMain, type SwizHookOutput, type SwizToolHook } from "../src/SwizHook.ts"
import { shellHookInputSchema } from "../src/schemas.ts"
import { preToolUseAllow, preToolUseDeny } from "../src/utils/hook-utils.ts"
import { escapeRegex, stripQuotedShellStrings } from "../src/utils/shell-patterns.ts"

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

    const tasksDir = `${getHomeDir()}/.claude/tasks`
    const stripped = stripQuotedShellStrings(command)
    const tasksDirRe = new RegExp(`${escapeRegex(tasksDir)}(?:/|\\s|$)`)

    if (
      tasksDirRe.test(stripped) ||
      /~\/\.claude\/tasks(?:\/|\s|$)/.test(stripped) ||
      /\$(?:\{HOME\}|HOME)\/.claude\/tasks(?:\/|\s|$)/.test(stripped)
    ) {
      return preToolUseDeny(DENY_REASON)
    }

    return preToolUseAllow("")
  },
}

export default pretooluseBlockTasksDirBash

if (import.meta.main) await runSwizHookAsMain(pretooluseBlockTasksDirBash)
