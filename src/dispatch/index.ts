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
}

// ─── Re-exports ─────────────────────────────────────────────────────────────

export {
  extractAllowReason,
  extractContext,
  groupMatches,
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
  toolMatchesToken,
} from "./engine.ts"
export {
  applyHookSettingFilters,
  countHooks,
  extractCwd,
  filterDisabledHooks,
  filterPrMergeModeHooks,
  filterStackHooks,
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
