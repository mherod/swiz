#!/usr/bin/env bun
// SessionStart hook (compact matcher): Re-inject core conventions after context compaction.

import { emitContext, type SessionHookInput } from "./hook-utils.ts"

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as SessionHookInput
  const matcher = input.matcher ?? input.trigger ?? ""

  // Only fire on compact/resume events, not fresh sessions
  if (matcher !== "compact" && matcher !== "resume") return

  const ctx =
    "Post-compaction context: Use rg instead of grep. Use the Edit/StrReplace tool, never sed/awk. " +
    "Do not co-author commits or PRs. Never disable code checks or quality gates. " +
    "Run git diff after reaching success. Check task list before starting new work."

  emitContext("SessionStart", ctx)
}

main()
