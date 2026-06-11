#!/usr/bin/env bun

// PreToolUse hook: Redirect task directory Glob/LS access to TaskList/TaskGet.

import { runSwizHookAsMain, type SwizHookOutput, type SwizToolHook } from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"
import { preToolUseAllow, preToolUseDeny } from "../src/utils/hook-utils.ts"
import {
  isProtectedTaskStoragePath,
  isProtectedTaskStoragePathResolved,
} from "./sandbox-path-utils.ts"

const DENY_REASON =
  "Use `TaskList` to see all tasks or `TaskGet` with a task ID to inspect a specific one."

const pretooluseBlockTasksDirGlob: SwizToolHook = {
  name: "pretooluse-block-tasks-dir-glob",
  event: "preToolUse",
  matcher: "Glob",
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
    // Glob uses `pattern`; LS uses `path`
    const target: string = toolInput.pattern ?? toolInput.path ?? ""
    if (!target) return preToolUseAllow("")

    if (await isProtectedTaskStoragePathResolved(target)) {
      return preToolUseDeny(DENY_REASON)
    }

    return preToolUseAllow("")
  },
}

export default pretooluseBlockTasksDirGlob

if (import.meta.main) await runSwizHookAsMain(pretooluseBlockTasksDirGlob)
