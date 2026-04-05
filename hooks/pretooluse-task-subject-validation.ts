#!/usr/bin/env bun
// Thin wrapper — logic lives in pretooluse-task-governance.ts § 2.
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { taskSubjectValidationHook } from "./pretooluse-task-governance.ts"

export default taskSubjectValidationHook
if (import.meta.main) await runSwizHookAsMain(taskSubjectValidationHook)
