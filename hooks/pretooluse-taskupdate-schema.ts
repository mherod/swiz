#!/usr/bin/env bun
// Thin wrapper — logic lives in pretooluse-task-governance.ts § 1.
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { taskupdateSchemaHook } from "./pretooluse-task-governance.ts"

export default taskupdateSchemaHook
if (import.meta.main) await runSwizHookAsMain(taskupdateSchemaHook)
