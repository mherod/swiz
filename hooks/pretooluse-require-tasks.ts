#!/usr/bin/env bun
// Thin wrapper — logic lives in pretooluse-task-governance.ts § 3.
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import {
  DIRECT_MERGE_INTENT_RE,
  evaluatePretooluseRequireTasks,
  isLargeContentPayload,
  requireTasksHook,
  requireTasksRunAsMainOptions,
} from "./pretooluse-task-governance.ts"

export { DIRECT_MERGE_INTENT_RE, evaluatePretooluseRequireTasks, isLargeContentPayload }
export default requireTasksHook
if (import.meta.main) await runSwizHookAsMain(requireTasksHook, requireTasksRunAsMainOptions)
