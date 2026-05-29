/**
 * Post-user-message grace window for task governance.
 *
 * For a short window after the user sends a message, task-governance blocks are
 * fully relaxed: the agent should be able to act on a fresh request immediately
 * without first satisfying buffer/staleness/rate-limit gates. The window is keyed
 * off the last user-message time, resolved via (in priority order):
 *   1. the daemon-injected `_lastUserMessageAt` payload field (hot-cache fast path), or
 *   2. a transcript tail scan (standalone hooks / daemon cold start).
 */

import { findLastUserMessageMsFromTranscript } from "../commands/daemon/cache/last-user-message-cache.ts"

/** Duration after a user message during which task-governance blocks are relaxed. */
export const USER_MESSAGE_GRACE_MS = 3 * 60 * 1000

/** Read the daemon-injected last user-message time (epoch ms) from the hook payload, if present. */
export function lastUserMessageAtFromPayload(input: Record<string, any>): number | null {
  const value = input?._lastUserMessageAt
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * Resolve the last user-message time (epoch ms): the daemon-injected payload field
 * when available, otherwise a transcript tail scan. Returns null when neither yields a time.
 */
export async function resolveLastUserMessageAt(input: Record<string, any>): Promise<number | null> {
  const injected = lastUserMessageAtFromPayload(input)
  if (injected !== null) return injected
  const transcriptPath = typeof input?.transcript_path === "string" ? input.transcript_path : ""
  if (!transcriptPath) return null
  return findLastUserMessageMsFromTranscript(transcriptPath)
}

/**
 * True when the most recent user message is within {@link USER_MESSAGE_GRACE_MS} of `nowMs`.
 * Fails closed (false) when no user-message time can be resolved.
 */
export async function isWithinUserMessageGrace(
  input: Record<string, any>,
  nowMs: number = Date.now()
): Promise<boolean> {
  const at = await resolveLastUserMessageAt(input)
  if (at === null) return false
  return nowMs - at <= USER_MESSAGE_GRACE_MS
}
