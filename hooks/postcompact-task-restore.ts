#!/usr/bin/env bun
// PostCompact hook: deterministically restore the task snapshot after compaction.
//
// Claude Code fires PostCompact immediately after the transcript is compacted —
// the exact moment the pre-compaction task snapshot (written by
// precompact-task-snapshot.ts) should be reconciled against the on-disk task
// files. Before this hook, recovery happened only indirectly through
// sessionstart-compact-context.ts (SessionStart with the "compact" matcher),
// which depends on SessionStart firing. This hook consumes the snapshot directly
// on the compaction event and injects the standard recovery guidance
// (TaskList + stale-task closure) as additionalContext, independent of any
// SessionStart heuristic. The SessionStart hook remains as a belt-and-suspenders
// fallback (and still covers the "resume" matcher).

import { getHomeDirWithFallback } from "../src/home.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { buildContextHookOutput, runSwizHookAsMain } from "../src/SwizHook.ts"
import { postCompactHookInputSchema } from "../src/schemas.ts"
import {
  buildTaskSections,
  COMPACT_CONTEXT_MAX_CHARS,
  joinSectionsWithinBudget,
  readCompactSnapshot,
} from "../src/tasks/compact-recovery.ts"

const RECOVERY_GUIDANCE =
  "Post-compaction recovery: run TaskList to re-sync the task queue, then reconcile each " +
  "task against reality — close stale tasks after checking `git log --oneline -3`, and keep " +
  "in-progress work marked accordingly. Always use rg instead of grep and the Edit tool, not sed/awk."

export async function evaluatePostcompactTaskRestore(input: unknown): Promise<SwizHookOutput> {
  const parsed = postCompactHookInputSchema.safeParse(input)
  if (!parsed.success) return {}

  const data = parsed.data as { session_id?: unknown }
  const sessionId = typeof data.session_id === "string" ? data.session_id : ""
  const home = getHomeDirWithFallback("")

  const sections: string[] = [RECOVERY_GUIDANCE]

  const snapshot = sessionId ? await readCompactSnapshot(sessionId, home) : null
  const taskSections = await buildTaskSections(snapshot, sessionId, home)
  sections.push(...taskSections)

  const ctx = joinSectionsWithinBudget(sections, COMPACT_CONTEXT_MAX_CHARS)
  return buildContextHookOutput("PostCompact", ctx)
}

const postcompactTaskRestore: SwizHook<Record<string, any>> = {
  name: "postcompact-task-restore",
  event: "postCompact",
  timeout: 5,
  run(input) {
    return evaluatePostcompactTaskRestore(input)
  },
}

export default postcompactTaskRestore

if (import.meta.main) {
  await runSwizHookAsMain(postcompactTaskRestore)
}
