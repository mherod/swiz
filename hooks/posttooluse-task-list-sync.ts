#!/usr/bin/env bun
// Thin wrapper — logic lives in posttooluse-task-sync.ts § 2.
import type { SwizHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { evaluatePosttooluseTaskListSync, taskListSyncHook } from "./posttooluse-task-sync.ts"

export { evaluatePosttooluseTaskListSync }
export default taskListSyncHook
if (import.meta.main) await runSwizHookAsMain(taskListSyncHook as SwizHook<Record<string, any>>)
