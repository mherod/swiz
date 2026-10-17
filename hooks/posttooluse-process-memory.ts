#!/usr/bin/env bun

/** PostToolUse context: report processes exceeding 24 GiB of resident RAM. */
import { evaluateProcessMemoryContext } from "../src/process-memory-context.ts"
import { runSwizHookAsMain, type SwizHook } from "../src/SwizHook.ts"

const posttooluseProcessMemory: SwizHook = {
  name: "posttooluse-process-memory",
  event: "postToolUse",
  timeout: 5,
  cooldownSeconds: 60,
  cooldownMode: "always",
  cooldownScope: "session",
  run(_input, context) {
    return evaluateProcessMemoryContext("PostToolUse", context)
  },
}

export default posttooluseProcessMemory

if (import.meta.main) await runSwizHookAsMain(posttooluseProcessMemory)
