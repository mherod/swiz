#!/usr/bin/env bun

// PreToolUse hook: Block direct edits/writes to the tasks session directory.

import { getHomeDir } from "../src/home.ts"
import { runSwizHookAsMain, type SwizHookOutput, type SwizToolHook } from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"
import { preToolUseAllow, preToolUseDeny } from "../src/utils/hook-utils.ts"

const DENY_REASON =
  "Use `TaskCreate`, `TaskUpdate`, or `TaskGet` to manage tasks instead of editing task files directly."

function isTasksPath(filePath: string, tasksDir: string): boolean {
  return filePath === tasksDir || filePath.startsWith(`${tasksDir}/`)
}

const pretooluseBlockTasksDirEdit: SwizToolHook = {
  name: "pretooluse-block-tasks-dir-edit",
  event: "preToolUse",
  matcher: "Edit|Write|NotebookEdit",
  timeout: 5,

  run(input): SwizHookOutput {
    const parsed = toolHookInputSchema.safeParse(input)
    if (!parsed.success) return preToolUseAllow("")

    const toolInput = (parsed.data as Record<string, any>).tool_input ?? {}
    const tasksDir = `${getHomeDir()}/.claude/tasks`

    // Edit and Write use file_path; NotebookEdit uses notebook_path
    const filePath: string = toolInput.file_path ?? toolInput.notebook_path ?? ""

    if (isTasksPath(filePath, tasksDir)) {
      return preToolUseDeny(DENY_REASON)
    }

    return preToolUseAllow("")
  },
}

export default pretooluseBlockTasksDirEdit

if (import.meta.main) await runSwizHookAsMain(pretooluseBlockTasksDirEdit)
