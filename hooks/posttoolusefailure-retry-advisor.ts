#!/usr/bin/env bun

// PostToolUseFailure hook: consume the direct tool-failure lifecycle signal.
//
// Claude Code emits PostToolUseFailure alongside PostToolUse when a tool call
// fails. Before this hook, failure-aware advisories (stuck-state, repeated
// lint/test, retry-loop) could only INFER failures by scanning the transcript.
// This hook consumes the failure event directly: it tracks consecutive failures
// of the same tool per session in memory and, once a tool fails repeatedly,
// emits a gentle advisory nudging a change of approach instead of a blind retry.

import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { postToolUseFailureHookInputSchema } from "../src/schemas.ts"
import { buildContextHookOutput } from "../src/utils/hook-utils.ts"

/** Consecutive same-tool failures before the retry advisory fires. */
export const RETRY_ADVISORY_THRESHOLD = 2

interface FailureStreak {
  tool: string
  count: number
}

// In-memory, per-session streak of the most recently failing tool. Mirrors the
// in-process event-state pattern (src/tasks/task-event-state.ts): authoritative
// for the live session, rebuilt naturally on restart. No transcript scan.
const failureStreaks = new Map<string, FailureStreak>()

/** Test/utility hook: clear all tracked failure streaks. */
export function resetFailureStreaks(): void {
  failureStreaks.clear()
}

export function evaluatePosttoolusefailureRetryAdvisor(input: unknown): SwizHookOutput {
  const parsed = postToolUseFailureHookInputSchema.safeParse(input)
  if (!parsed.success) return {}

  const data = parsed.data as { session_id?: unknown; tool_name?: unknown }
  const sessionId = typeof data.session_id === "string" ? data.session_id : ""
  const toolName = typeof data.tool_name === "string" ? data.tool_name : ""
  if (!sessionId || !toolName) return {}

  const prev = failureStreaks.get(sessionId)
  const streak: FailureStreak =
    prev && prev.tool === toolName
      ? { tool: toolName, count: prev.count + 1 }
      : { tool: toolName, count: 1 }
  failureStreaks.set(sessionId, streak)

  if (streak.count < RETRY_ADVISORY_THRESHOLD) return {}

  return buildContextHookOutput(
    "PostToolUseFailure",
    `${toolName} has now failed ${streak.count} times in a row. Stop and read the actual error before retrying — ` +
      `change the approach, fix the root cause, or check assumptions rather than re-running the same call.`
  )
}

const posttoolusefailureRetryAdvisor: SwizHook<Record<string, any>> = {
  name: "posttoolusefailure-retry-advisor",
  event: "postToolUseFailure",
  timeout: 5,
  run(input) {
    return evaluatePosttoolusefailureRetryAdvisor(input)
  },
}

export default posttoolusefailureRetryAdvisor

if (import.meta.main) {
  await runSwizHookAsMain(posttoolusefailureRetryAdvisor)
}
