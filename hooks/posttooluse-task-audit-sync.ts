#!/usr/bin/env bun
// Thin wrapper — logic lives in posttooluse-task-sync.ts § 1.
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { evaluatePosttooluseTaskAuditSync, taskAuditSyncHook } from "./posttooluse-task-sync.ts"

export { evaluatePosttooluseTaskAuditSync }
export default taskAuditSyncHook
if (import.meta.main) await runSwizHookAsMain(taskAuditSyncHook as any)
