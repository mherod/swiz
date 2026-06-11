#!/usr/bin/env bun

// PreToolUse hook: Block direct edits/writes to the tasks session directory.

import { runSwizHookAsMain, type SwizHookOutput, type SwizToolHook } from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"
import { preToolUseAllow, preToolUseDeny } from "../src/utils/hook-utils.ts"
import {
  isProtectedTaskStoragePath,
  isProtectedTaskStoragePathResolved,
} from "./sandbox-path-utils.ts"

const DENY_REASON =
  "Use `TaskCreate`, `TaskUpdate`, or `TaskGet` to manage tasks instead of editing task files directly."

const pretooluseBlockTasksDirEdit: SwizToolHook = {
  name: "pretooluse-block-tasks-dir-edit",
  event: "preToolUse",
  matcher: "Edit|Write|NotebookEdit",
  timeout: 5,

  async run(input): Promise<SwizHookOutput> {
    const parsed = toolHookInputSchema.safeParse(input)
    if (!parsed.success) {
      // Fail closed if the raw payload still references a protected task path.
      return isProtectedTaskStoragePath(JSON.stringify(input))
        ? preToolUseDeny(DENY_REASON)
        : preToolUseAllow("")
    }

    const toolInput = (parsed.data as Record<string, any>).tool_input ?? {}
    // Edit and Write use file_path; NotebookEdit uses notebook_path
    const filePath: string = toolInput.file_path ?? toolInput.notebook_path ?? ""

    if (await isProtectedTaskStoragePathResolved(filePath)) {
      return preToolUseDeny(DENY_REASON)
    }

    return preToolUseAllow("")
  },
}

export default pretooluseBlockTasksDirEdit

if (import.meta.main) await runSwizHookAsMain(pretooluseBlockTasksDirEdit)
