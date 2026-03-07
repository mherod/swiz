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
  subagentError: "blocking",
  sessionEnd: "blocking",
}

// ─── Re-exports ─────────────────────────────────────────────────────────────

export {
  classifyHookOutput,
  DEFAULT_TIMEOUT,
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
  runBlocking,
  runContext,
  runHook,
  runPreToolUse,
  type SkipReason,
  toolMatchesToken,
} from "./engine.ts"
export {
  applyHookSettingFilters,
  countHooks,
  extractCwd,
  filterDisabledHooks,
  filterPrMergeModeHooks,
  filterStackHooks,
  filterStateHooks,
  hookCooldownPath,
  isWithinCooldown,
  markHookCooldown,
  resolvePrMergeActive,
} from "./filters.ts"

export {
  formatTrace,
  replayBlocking,
  replayContext,
  replayPreToolUse,
  type TraceEntry,
} from "./replay.ts"
