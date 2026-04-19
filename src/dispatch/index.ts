/**
 * Dispatch module barrel — re-exports all public symbols from sub-modules.
 *
 * Import from "src/dispatch/index.ts" (or "src/dispatch") to access
 * filters, engine, and replay functionality.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type { DispatchStrategy } from "./types.ts"

// ─── Routing table ──────────────────────────────────────────────────────────

import type { DispatchStrategy } from "./types.ts"

export const DISPATCH_ROUTES: Record<string, DispatchStrategy> = {
  preToolUse: "preToolUse",
  stop: "blocking",
  postToolUse: "blocking",
  sessionStart: "context",
  userPromptSubmit: "context",
  preCompact: "context",
  notification: "context",
  subagentStart: "context",
  subagentStop: "blocking",
  sessionEnd: "blocking",
  preCommit: "blocking",
  commitMsg: "blocking",
  prePush: "blocking",
}

// ─── Re-exports ─────────────────────────────────────────────────────────────

export { INTERNAL_DISPATCH_RESPONSE_KEYS, stripInternalDispatchFields } from "./dispatch-wire.ts"
export {
  assertDispatchInboundNotParseError,
  assertEnrichedDispatchPayloadRecord,
  assertNormalizedDispatchPayload,
  coerceDispatchAgentEnvelopeInPlace,
  DISPATCH_CANONICAL_INBOUND_SCHEMAS,
  DispatchPayloadValidationError,
  dispatchInboundObjectSchema,
  parseDispatchPayloadString,
  parseValidatedAgentDispatchWireJson,
} from "./dispatch-zod-surfaces.ts"
export {
  buildSpawnContext,
  classifyHookOutput,
  DEFAULT_TIMEOUT,
  didWriteDispatchResponse,
  extractAllowReason,
  extractContext,
  groupMatches,
  type HookExecution,
  type HookRunResult,
  type HookStatus,
  isAllowWithReason,
  isBlock,
  isDeny,
  launchAsyncHooks,
  log,
  logHeader,
  markDispatchResponseWritten,
  type PreParsedSpawnContext,
  resetDispatchResponseWriteState,
  runHook,
  type SkipReason,
  toolMatchesToken,
  withLogBuffer,
} from "./engine.ts"
export {
  type DispatchRequest,
  type DispatchResult,
  executeDispatch,
  getHookContext,
  parsePayload,
} from "./execute.ts"
export {
  applyHookSettingFilters,
  countHooks,
  extractCwd,
  filterDisabledHooks,
  filterPrMergeModeHooks,
  filterRequiredSettingsHooks,
  filterStackHooks,
  filterStateHooks,
  hookCooldownPath,
  isWithinCooldown,
  markHookCooldown,
  resolvePrMergeActive,
} from "./filters.ts"
export {
  scheduleIncomingDispatchCapture,
  shouldCaptureIncomingPayloads,
} from "./incoming-capture.ts"
export { backfillPayloadDefaults } from "./payload-backfill.ts"
export { normalizeAgentHookPayload } from "./payload-normalize.ts"
export {
  formatTrace,
  replayBlocking,
  replayContext,
  replayPreToolUse,
  type TraceEntry,
} from "./replay.ts"
