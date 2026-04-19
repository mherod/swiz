import { merge, unset } from "lodash-es"
import type { HookGroup } from "../manifest.ts"
import { BlockingStrategy } from "./blockingStrategy.ts"
import { ContextStrategy } from "./contextStrategy.ts"
import { coerceDispatchAgentEnvelopeInPlace } from "./dispatch-zod-surfaces.ts"
import {
  buildSpawnContext,
  flatSyncHooks,
  type HookExecution,
  launchAsyncHooks,
  log,
  logSlowHookSummary,
  runEntry,
  writeResponse,
} from "./engine.ts"
import type { EnrichedDispatchPayload } from "./execute.ts"
import { PreToolUseStrategy } from "./preToolUseStrategy.ts"
import { isStopLikeDispatchEvent, normalizeStopDispatchResponseInPlace } from "./stop-response.ts"
import type { DispatchStrategy } from "./types.ts"

/** Context passed to each hook execution strategy. */
export interface HookStrategyContext {
  filteredGroups: HookGroup[]
  enrichedPayloadStr: string
  canonicalEvent: string
  hookEventName: string
  daemonContext?: boolean
  /** Working directory already resolved by executeDispatch — avoids re-parsing enrichedPayloadStr. */
  cwd: string
  /** Dispatch-level abort signal — when fired, all running hook processes should be killed. */
  signal?: AbortSignal
}

/** Interface for hook execution strategies. */
export interface HookExecutionStrategy<T = Record<string, any>> {
  execute(ctx: HookStrategyContext): Promise<T>
}

// ─── Shared strategy pipeline ──────────────────────────────────────────────

type HookResult = { execution: HookExecution; parsed: Record<string, any> | null }

/**
 * Shared scaffolding for all three strategies: sets up an AbortController,
 * fans out sync hooks concurrently with fire-and-forget async hooks, cleans up
 * the abort listener, attaches hookExecutions to the response, and writes stdout.
 *
 * Hooks with `async: true` and `asyncMode: "block-until-complete"` are included
 * in the sync fan-out (via `flatSyncHooks`) and are fully awaited like non-async hooks.
 *
 * `onResult` is called per-hook to let the strategy short-circuit (abort)
 * when a deny/block is detected. `processResults` builds the final response
 * from the collected results.
 *
 * `collectionTimeoutMs` — when set, the pipeline waits up to this many
 * milliseconds for all hooks to settle before aborting stragglers. This
 * prevents fast-completing hooks from starving slower (but valuable) hooks
 * that need network I/O or heavier processing.
 */
export async function runStrategyPipeline(
  ctx: HookStrategyContext,
  opts: {
    onResult?: (result: HookResult, abort: () => void) => void
    processResults: (results: HookResult[], executions: HookExecution[]) => Record<string, any>
    /** Max time to wait for all hooks before aborting stragglers. */
    collectionTimeoutMs?: number
  }
): Promise<Record<string, any>> {
  const { filteredGroups, enrichedPayloadStr, daemonContext, cwd } = ctx
  const entries = flatSyncHooks(filteredGroups)
  const controller = new AbortController()
  const { signal } = controller

  // Parse spawn context ONCE for all hooks in this dispatch — avoids
  // O(hooks) JSON.parse + env-merge allocations in runHook/runEntry.
  const spawnCtx = buildSpawnContext(enrichedPayloadStr)

  const onDispatchAbort = () => controller.abort()
  ctx.signal?.addEventListener("abort", onDispatchAbort, { once: true })

  // When a collection timeout is set, abort remaining hooks after the window
  // expires rather than relying solely on per-hook onResult abort.
  let collectionTimer: ReturnType<typeof setTimeout> | null = null
  if (opts.collectionTimeoutMs) {
    collectionTimer = setTimeout(() => controller.abort(), opts.collectionTimeoutMs)
  }

  const [results] = await Promise.all([
    Promise.all(
      entries.map(async (e) => {
        const result = await runEntry(e, enrichedPayloadStr, cwd, signal, spawnCtx)
        opts.onResult?.(result, () => controller.abort())
        return result
      })
    ),
    launchAsyncHooks(filteredGroups, enrichedPayloadStr, daemonContext, ctx.signal, spawnCtx),
  ])

  if (collectionTimer) clearTimeout(collectionTimer)

  ctx.signal?.removeEventListener("abort", onDispatchAbort)

  const executions: HookExecution[] = []
  const finalResponse = opts.processResults(results, executions)

  logSlowHookSummary(executions)
  if (executions.length > 0) merge(finalResponse, { hookExecutions: executions })
  if (isStopLikeDispatchEvent(ctx.canonicalEvent)) {
    normalizeStopDispatchResponseInPlace(finalResponse, ctx.hookEventName)
  }

  coerceDispatchAgentEnvelopeInPlace(finalResponse, ctx.canonicalEvent, ctx.hookEventName)

  writeResponse(finalResponse)
  return finalResponse
}

// ─── Strategy implementations ──────────────────────────────────────────────

/**
 * Blocking strategy: forwards first block and aborts remaining hooks.
 * Used for postToolUse events.
 *
 * For **stop** events the strategy switches to an aggregation mode: all hooks
 * run concurrently for up to {@link STOP_COLLECTION_TIMEOUT_MS} and every
 * blocking reason is merged into a single response. This prevents fast
 * file-based checks from starving slower but valuable hooks (like
 * `stop-personal-repo-issues`) that need network I/O.
 */
async function resolveAutoSteerEnabled(
  payload: EnrichedDispatchPayload,
  sessionId: string
): Promise<boolean> {
  const injected = payload._effectiveSettings
  if (injected && typeof injected.autoSteer === "boolean") return injected.autoSteer
  const { isAutoSteerAvailable } = await import("../utils/hook-utils.ts")
  return (await isAutoSteerAvailable(sessionId)) !== null
}

/** Resolved auto-steer context from an enriched payload. */
interface StopAutoSteerContext {
  sessionId: string
  safeSession: string
  terminalApp: string
}

/** Extract and validate auto-steer prerequisites from a stop payload. */
async function resolveStopAutoSteerContext(
  enrichedPayloadStr: string
): Promise<StopAutoSteerContext | null> {
  const payload = JSON.parse(enrichedPayloadStr) as Record<string, any>
  const sessionId = (payload.session_id as string) ?? ""
  if (!sessionId) return null

  const autoSteerEnabled = await resolveAutoSteerEnabled(payload, sessionId)
  if (!autoSteerEnabled) return null

  const { sanitizeSessionId } = await import("../../src/session-id.ts")
  const safeSession = sanitizeSessionId(sessionId)
  if (!safeSession) return null

  const terminalApp = (payload._terminal as { app: string } | undefined)?.app ?? null
  if (!terminalApp) return null

  return { sessionId, safeSession, terminalApp }
}

/**
 * Short-circuit stop hooks when on_session_stop auto-steer messages are queued.
 * Delivers all pending messages and returns true to skip the full hook chain.
 */
export async function tryOnSessionStopDelivery(enrichedPayloadStr: string): Promise<boolean> {
  const ctx = await resolveStopAutoSteerContext(enrichedPayloadStr)
  if (!ctx) return false

  const { getAutoSteerStore } = await import("../../src/auto-steer-store.ts")
  const store = getAutoSteerStore()
  if (!store.hasPending(ctx.safeSession, "on_session_stop")) return false

  const { sendAutoSteer } = await import("../utils/hook-utils.ts")
  const sent = new Set<string>()
  let deliveredCount = 0
  // Drain all pending on_session_stop messages using thread-safe consumeOne().
  let batch = store.consumeOne(ctx.safeSession, "on_session_stop")
  while (batch.length > 0) {
    const req = batch[0]!
    deliveredCount++
    if (!sent.has(req.message)) {
      const ok = await sendAutoSteer(req.message, ctx.terminalApp)
      if (ok) {
        log(`   auto-steer: delivered on_session_stop message to terminal (${ctx.terminalApp})`)
      }
      sent.add(req.message)
    }
    batch = store.consumeOne(ctx.safeSession, "on_session_stop")
  }
  log(`   on_session_stop: short-circuited ${deliveredCount} message(s) — skipping stop hooks`)
  return true
}

export async function tryAutoSteerStopBlock(
  finalResponse: Record<string, any>,
  enrichedPayloadStr: string
): Promise<void> {
  const blockReason = (finalResponse as { reason?: string }).reason ?? ""
  if (!blockReason) return

  const ctx = await resolveStopAutoSteerContext(enrichedPayloadStr)
  if (!ctx) return

  // Send-side dedup: skip if this exact block reason was recently delivered
  const { getAutoSteerStore: getStore } = await import("../../src/auto-steer-store.ts")
  if (getStore().wasRecentlyDelivered(ctx.safeSession, blockReason, "on_session_stop")) return

  const { sendAutoSteer } = await import("../utils/hook-utils.ts")
  const sent = await sendAutoSteer(blockReason, ctx.terminalApp)
  if (!sent) return
  log(
    `   auto-steer: sent stop block reason to terminal (${ctx.terminalApp}) — converting to allow`
  )
  unset(finalResponse, "decision")
  unset(finalResponse, "reason")
}

/** Registry mapping dispatch strategy names to their implementations. */
export const STRATEGY_REGISTRY: Record<DispatchStrategy, HookExecutionStrategy> = {
  preToolUse: new PreToolUseStrategy(),
  blocking: new BlockingStrategy(),
  context: new ContextStrategy(),
}
