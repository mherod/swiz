/**
 * Shared types and pipeline for hook execution strategies.
 * Extracted to break circular imports when strategy implementations
 * are split into separate modules.
 */

import { merge } from "lodash-es"
import type { HookGroup } from "../manifest.ts"
import { coerceDispatchAgentEnvelopeInPlace } from "./dispatch-zod-surfaces.ts"
import type { HookExecution } from "./engine.ts"
import {
  buildSpawnContext,
  flatSyncHooks,
  launchAsyncHooks,
  logSlowHookSummary,
  runEntry,
  writeResponse,
} from "./engine.ts"
import { isStopLikeDispatchEvent, normalizeStopDispatchResponseInPlace } from "./stop-response.ts"

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
