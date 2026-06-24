#!/usr/bin/env bun
// SessionStart hook (compact matcher): Re-inject core conventions after context compaction.
// Also reads the compact-snapshot.json written by precompact-task-snapshot.ts to verify
// and recreate any task files that may be missing after compaction.

import { getHomeDirWithFallback } from "../src/home.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { buildContextHookOutput, runSwizHookAsMain } from "../src/SwizHook.ts"
import { sessionStartHookInputSchema } from "../src/schemas.ts"
import {
  buildTaskSections,
  COMPACT_CONTEXT_MAX_CHARS,
  joinSectionsWithinBudget,
  readCompactSnapshot,
} from "../src/tasks/compact-recovery.ts"

export async function evaluateSessionstartCompactContext(input: unknown): Promise<SwizHookOutput> {
  const hookInput = sessionStartHookInputSchema.parse(input)
  const matcher = hookInput.matcher ?? hookInput.trigger ?? ""
  if (matcher !== "compact" && matcher !== "resume") return {}

  const sections: string[] = [
    "Post-compaction context: Always use rg instead of grep. Use Edit tool, not sed/awk. " +
      "Do not co-author commits. Never disable code checks or quality gates. " +
      "Run git diff after reaching success.",
  ]

  const sessionId = hookInput.session_id ?? ""
  const home = getHomeDirWithFallback("")

  const snapshot = sessionId ? await readCompactSnapshot(sessionId, home) : null
  const taskSections = await buildTaskSections(snapshot, sessionId, home)
  sections.push(...taskSections)

  const ctx = joinSectionsWithinBudget(sections, COMPACT_CONTEXT_MAX_CHARS)
  return buildContextHookOutput("SessionStart", ctx)
}

const sessionstartCompactContext: SwizHook<Record<string, any>> = {
  name: "sessionstart-compact-context",
  event: "sessionStart",
  matcher: "compact",
  timeout: 5,
  run(input) {
    return evaluateSessionstartCompactContext(input)
  },
}

export default sessionstartCompactContext

if (import.meta.main) {
  await runSwizHookAsMain(sessionstartCompactContext)
}
