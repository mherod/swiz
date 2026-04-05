#!/usr/bin/env bun
// Thin wrapper — logic lives in pretooluse-task-governance.ts § 4.
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import {
  enforceTaskupdateHook,
  evaluatePretooluseEnforceTaskupdate,
} from "./pretooluse-task-governance.ts"

export { evaluatePretooluseEnforceTaskupdate }
export default enforceTaskupdateHook
if (import.meta.main) await runSwizHookAsMain(enforceTaskupdateHook)
