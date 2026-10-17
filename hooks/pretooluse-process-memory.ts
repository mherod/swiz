#!/usr/bin/env bun

/** PreToolUse context: report processes exceeding 24 GiB of resident RAM. */
import { evaluateProcessMemoryContext } from "../src/process-memory-context.ts"
import { runSwizHookAsMain, type SwizHook } from "../src/SwizHook.ts"

const pretooluseProcessMemory: SwizHook = {
  name: "pretooluse-process-memory",
  event: "preToolUse",
  timeout: 5,
  cooldownSeconds: 60,
  cooldownMode: "always",
  cooldownScope: "session",
  run(_input, context) {
    return evaluateProcessMemoryContext("PreToolUse", context)
  },
}

export default pretooluseProcessMemory

if (import.meta.main) await runSwizHookAsMain(pretooluseProcessMemory)
