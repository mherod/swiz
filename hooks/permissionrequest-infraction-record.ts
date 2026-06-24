#!/usr/bin/env bun
// PermissionRequest hook: surface auto-mode permission denials to the infraction layer.
//
// Claude Code fires PermissionRequest when a tool call needs a permission decision
// (in auto/dontAsk modes this is the gate that would otherwise silently deny). Before
// this hook, the infraction-escalation layer (hooks/pretooluse-infraction-escalation.ts
// + src/infractions.ts) only ever saw hook-blocked or successful calls — never the
// permission-gated attempts. This hook records each permission request per session,
// keyed by the SAME attemptKey the infraction scanner uses, so a tool/command that
// repeatedly needs permission escalates an advisory instead of being re-attempted
// blindly. Mirrors the in-memory per-session streak pattern of
// posttoolusefailure-retry-advisor.ts (authoritative for the live session, rebuilt on
// restart, no state files).

import { attemptKey } from "../src/infractions.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { buildContextHookOutput, runSwizHookAsMain } from "../src/SwizHook.ts"
import { permissionRequestHookInputSchema } from "../src/schemas.ts"

/** Repeated permission requests for the same action before the advisory escalates. */
export const PERMISSION_ESCALATION_THRESHOLD = 2

// In-memory per-session count of permission requests keyed by attemptKey. Same shape
// as task-event-state / failureStreaks: live-session authoritative, no persistence.
const requestCounts = new Map<string, Map<string, number>>()

/** Test/utility hook: clear all tracked permission-request counts. */
export function resetPermissionRequestCounts(): void {
  requestCounts.clear()
}

export function evaluatePermissionrequestInfractionRecord(input: unknown): SwizHookOutput {
  const parsed = permissionRequestHookInputSchema.safeParse(input)
  if (!parsed.success) return {}

  const data = parsed.data as {
    session_id?: unknown
    tool_name?: unknown
    tool_input?: unknown
  }
  const sessionId = typeof data.session_id === "string" ? data.session_id : ""
  const toolName = typeof data.tool_name === "string" ? data.tool_name : ""
  if (!sessionId || !toolName) return {}

  const toolInput =
    data.tool_input && typeof data.tool_input === "object"
      ? (data.tool_input as Record<string, unknown>)
      : undefined
  const key = attemptKey(toolName, toolInput)
  if (!key) return {}

  let perSession = requestCounts.get(sessionId)
  if (!perSession) {
    perSession = new Map<string, number>()
    requestCounts.set(sessionId, perSession)
  }
  const count = (perSession.get(key) ?? 0) + 1
  perSession.set(key, count)

  if (count < PERMISSION_ESCALATION_THRESHOLD) return {}

  return buildContextHookOutput(
    "PermissionRequest",
    `${toolName} has needed permission ${count} times for the same action this session. ` +
      `Stop re-attempting the gated call — confirm it is actually permitted, change the approach, ` +
      `or take the action the permission gate is protecting rather than requesting it again.`
  )
}

const permissionrequestInfractionRecord: SwizHook<Record<string, any>> = {
  name: "permissionrequest-infraction-record",
  event: "permissionRequest",
  timeout: 5,
  run(input) {
    return evaluatePermissionrequestInfractionRecord(input)
  },
}

export default permissionrequestInfractionRecord

if (import.meta.main) {
  await runSwizHookAsMain(permissionrequestInfractionRecord)
}
