import { merge, unset } from "lodash-es"
import { hookOutputSchema } from "../../hooks/schemas.ts"
import type { HookGroup } from "../manifest.ts"
import {
  getHookSpecificOutput,
  hsoContextEvent,
  hsoPreToolUseMergedAllow,
  mergeHookSpecificOutputClone,
} from "../utils/hook-specific-output.ts"
import { coerceDispatchAgentEnvelopeInPlace } from "./dispatch-zod-surfaces.ts"
import {
  extractAllowReason,
  extractContext,
  flatSyncHooks,
  type HookExecution,
  isBlock,
  isDeny,
  launchAsyncHooks,
  log,
  logSlowHookSummary,
  runEntry,
  writeResponse,
} from "./engine.ts"
import { extractCwd } from "./filters.ts"
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
export interface HookExecutionStrategy {
  execute(ctx: HookStrategyContext): Promise<Record<string, unknown>>
}

/**
 * PreToolUse strategy: short-circuits on first deny; collects and merges
 * allow-with-reason hints.
 */
type PreToolResult = "deny" | "hint" | "pass"

function classifyAllowHint(
  resp: Record<string, unknown>,
  execution: HookExecution,
  hints: string[],
  contexts: string[]
): boolean {
  const hso = getHookSpecificOutput(resp)
  const reason = extractAllowReason(resp)
  const context = extractContext(resp)
  if (hso?.permissionDecision !== "allow" || (!reason && !context)) return false
  execution.status = "allow-with-reason"
  if (reason) hints.push(reason)
  if (context) contexts.push(context)
  log(`   ~ ${execution.file} (hint: ${(reason ?? context ?? "").slice(0, 100)})`)
  return true
}

function classifyPreToolResult(
  execution: HookExecution,
  resp: Record<string, unknown> | null,
  hints: string[],
  contexts: string[]
): PreToolResult {
  if (resp && isDeny(resp)) {
    execution.status = "deny"
    log(`   ✗ DENY from ${execution.file}`)
    return "deny"
  }
  if (resp && classifyAllowHint(resp, execution, hints, contexts)) return "hint"
  log(`   ✓ ${execution.file} (${resp ? "allow" : "no output"})`)
  return "pass"
}

function buildPreToolResponse(hints: string[], contexts: string[]): Record<string, unknown> {
  if (hints.length === 0 && contexts.length === 0) {
    log(`   result: all passed`)
    return hookOutputSchema.parse({})
  }
  log(
    `   result: passed with ${hints.length} hint(s)` +
      (contexts.length > 0 ? ` and ${contexts.length} context(s)` : "")
  )
  return hookOutputSchema.parse({
    ...(contexts.length > 0 ? { systemMessage: contexts.join("\n\n") } : {}),
    hookSpecificOutput: hsoPreToolUseMergedAllow({
      hintsJoined: hints.length > 0 ? hints.join("\n\n") : undefined,
      contextsJoined: contexts.length > 0 ? contexts.join("\n\n") : undefined,
    }),
  })
}

// ─── Shared strategy pipeline ──────────────────────────────────────────────

type HookResult = { execution: HookExecution; parsed: Record<string, unknown> | null }

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
 */
async function runStrategyPipeline(
  ctx: HookStrategyContext,
  opts: {
    onResult?: (result: HookResult, abort: () => void) => void
    processResults: (results: HookResult[], executions: HookExecution[]) => Record<string, unknown>
  }
): Promise<Record<string, unknown>> {
  const { filteredGroups, enrichedPayloadStr, daemonContext, cwd } = ctx
  const entries = flatSyncHooks(filteredGroups)
  const controller = new AbortController()
  const { signal } = controller

  const onDispatchAbort = () => controller.abort()
  ctx.signal?.addEventListener("abort", onDispatchAbort, { once: true })

  const [results] = await Promise.all([
    Promise.all(
      entries.map(async (e) => {
        const result = await runEntry(e, enrichedPayloadStr, cwd, signal)
        opts.onResult?.(result, () => controller.abort())
        return result
      })
    ),
    launchAsyncHooks(filteredGroups, enrichedPayloadStr, daemonContext, ctx.signal),
  ])

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

class PreToolUseStrategy implements HookExecutionStrategy {
  async execute(ctx: HookStrategyContext): Promise<Record<string, unknown>> {
    const hints: string[] = []
    const contexts: string[] = []
    const finalResponse: Record<string, unknown> = {}

    return runStrategyPipeline(ctx, {
      onResult: (result, abort) => {
        if (result.parsed && isDeny(result.parsed)) abort()
      },
      processResults: (results, executions) => {
        for (const { execution, parsed: resp } of results) {
          if (execution.status === "skipped" || execution.status === "aborted") {
            executions.push(execution)
            continue
          }
          const classification = classifyPreToolResult(execution, resp, hints, contexts)
          executions.push(execution)
          if (classification === "deny") {
            merge(finalResponse, resp)
            break
          }
        }
        if (!isDeny(finalResponse)) {
          merge(finalResponse, buildPreToolResponse(hints, contexts))
        }
        return finalResponse
      },
    })
  }
}

/** Process blocking hook results, collecting contexts from all hooks.
 *  For stop events: runs all hooks, forwards first block, merges all contexts.
 *  For other events: may have been aborted early, but still collects contexts
 *  from any hooks that completed before abort.
 *
 *  Exported for unit tests (see `strategies.test.ts`). */
export function processBlockingResults(
  results: Array<{ execution: HookExecution; parsed: Record<string, unknown> | null }>,
  executions: HookExecution[],
  finalResponse: Record<string, unknown>,
  hookEventName: string
): void {
  const contexts: string[] = []
  let firstBlockHandled = false

  for (const { execution, parsed: resp } of results) {
    if (execution.status === "skipped" || execution.status === "aborted") {
      executions.push(execution)
      continue
    }

    if (resp && isBlock(resp)) {
      log(`   ✗ BLOCK from ${execution.file}`)
      execution.status = "block"

      if (!firstBlockHandled) {
        // First block: copy its entire response as the final response
        merge(finalResponse, resp)
        firstBlockHandled = true
        // Still collect additionalContext via extractContext so it is flattened into
        // systemMessage (agents read top-level systemMessage; nested hso alone is insufficient).
        const firstCtx = extractContext(resp)
        if (firstCtx) contexts.push(firstCtx)
      } else {
        // Subsequent blocks: only extract their context (if any) for inclusion
        const ctx = extractContext(resp)
        if (ctx) contexts.push(ctx)
      }

      executions.push(execution)
      // Continue processing remaining hooks to collect contexts and executions
      continue
    }

    // Non-block hook: extract per-hook additionalContext for merging
    if (resp) {
      const ctx = extractContext(resp)
      if (ctx) contexts.push(ctx)
    }

    log(`   ✓ ${execution.file} (${resp ? "ok" : "no output"})`)
    executions.push(execution)
  }

  if (contexts.length > 0) {
    const mergedContext = contexts.join("\n\n")
    finalResponse.systemMessage = `${finalResponse.systemMessage ? `${finalResponse.systemMessage}\n\n` : ""}${mergedContext}`

    const existingHso = mergeHookSpecificOutputClone(finalResponse, hookEventName)
    existingHso.additionalContext = mergedContext
    finalResponse.hookSpecificOutput = existingHso
  }
}

/**
 * Blocking strategy: forwards first block and aborts remaining hooks.
 * Used for stop and postToolUse events.
 */
async function resolveAutoSteerEnabled(
  payload: Record<string, unknown>,
  sessionId: string
): Promise<boolean> {
  const injected = payload._effectiveSettings as Record<string, unknown> | undefined
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
  const payload = JSON.parse(enrichedPayloadStr) as Record<string, unknown>
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
async function tryOnSessionStopDelivery(enrichedPayloadStr: string): Promise<boolean> {
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

async function tryAutoSteerStopBlock(
  finalResponse: Record<string, unknown>,
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

class BlockingStrategy implements HookExecutionStrategy {
  async execute(ctx: HookStrategyContext): Promise<Record<string, unknown>> {
    const { canonicalEvent, enrichedPayloadStr } = ctx

    // on_session_stop: short-circuit all stop hooks if pending messages exist.
    if (canonicalEvent === "stop") {
      const shortCircuited = await tryOnSessionStopDelivery(enrichedPayloadStr)
      if (shortCircuited) {
        const response: Record<string, unknown> = {}
        normalizeStopDispatchResponseInPlace(response, ctx.hookEventName)
        coerceDispatchAgentEnvelopeInPlace(response, ctx.canonicalEvent, ctx.hookEventName)
        writeResponse(response)
        return response
      }
    }

    const finalResponse: Record<string, unknown> = {}

    const response = await runStrategyPipeline(ctx, {
      onResult: (result, abort) => {
        // Stop events should run all hooks to collect all results; only abort for other events
        if (ctx.canonicalEvent !== "stop" && result.parsed && isBlock(result.parsed)) {
          abort()
        }
      },
      processResults: (results, executions) => {
        processBlockingResults(results, executions, finalResponse, ctx.hookEventName)
        if (!isBlock(finalResponse)) {
          log(`   result: all passed`)
        }
        return finalResponse
      },
    })

    if (canonicalEvent === "stop" && isBlock(response)) {
      await tryAutoSteerStopBlock(response, enrichedPayloadStr)
    }

    return response
  }
}

/**
 * Context strategy: runs all hooks, merges additionalContext for
 * sessionStart and userPromptSubmit events.
 */
class ContextStrategy implements HookExecutionStrategy {
  async execute(ctx: HookStrategyContext): Promise<Record<string, unknown>> {
    const { hookEventName } = ctx
    const contexts: string[] = []

    return runStrategyPipeline(ctx, {
      processResults: (results, executions) => {
        for (const { execution, parsed: resp } of results) {
          if (execution.status === "skipped" || execution.status === "aborted") {
            executions.push(execution)
            continue
          }
          if (!resp) {
            log(`   ✓ ${execution.file} (no output)`)
            executions.push(execution)
            continue
          }
          const ctxText = extractContext(resp)
          if (ctxText) {
            execution.status = "allow-with-reason"
            contexts.push(ctxText)
            log(`   ✓ ${execution.file} (context: ${ctxText.slice(0, 100)})`)
          } else {
            log(`   ✓ ${execution.file} (no context extracted)`)
          }
          executions.push(execution)
        }

        if (contexts.length === 0) {
          log(`   result: no contexts to merge`)
          return hookOutputSchema.parse({})
        }
        log(`   result: merged ${contexts.length} context(s), hookEventName=${hookEventName}`)
        return hookOutputSchema.parse({
          hookSpecificOutput: hsoContextEvent(hookEventName, contexts.join("\n\n")),
        })
      },
    })
  }
}

/** Registry mapping dispatch strategy names to their implementations. */
export const STRATEGY_REGISTRY: Record<DispatchStrategy, HookExecutionStrategy> = {
  preToolUse: new PreToolUseStrategy(),
  blocking: new BlockingStrategy(),
  context: new ContextStrategy(),
}

// ─── Standalone compatibility wrappers ───────────────────────────────────────

/** Wrapper for backward compatibility; calls preToolUse strategy. */
export async function runPreToolUse(
  groups: HookGroup[],
  payloadStr: string,
  daemonContext?: boolean
): Promise<Record<string, unknown>> {
  return STRATEGY_REGISTRY.preToolUse.execute({
    filteredGroups: groups,
    enrichedPayloadStr: payloadStr,
    canonicalEvent: "preToolUse",
    hookEventName: "preToolUse",
    daemonContext,
    cwd: extractCwd(payloadStr),
  })
}

/** Wrapper for backward compatibility; calls blocking strategy. */
export async function runBlocking(
  groups: HookGroup[],
  payloadStr: string,
  canonicalEvent?: string,
  daemonContext?: boolean
): Promise<Record<string, unknown>> {
  return STRATEGY_REGISTRY.blocking.execute({
    filteredGroups: groups,
    enrichedPayloadStr: payloadStr,
    canonicalEvent: canonicalEvent ?? "blocking",
    hookEventName: canonicalEvent ?? "blocking",
    daemonContext,
    cwd: extractCwd(payloadStr),
  })
}

/** Wrapper for backward compatibility; calls context strategy. */
export async function runContext(
  groups: HookGroup[],
  payloadStr: string,
  hookEventName: string,
  daemonContext?: boolean
): Promise<Record<string, unknown>> {
  return STRATEGY_REGISTRY.context.execute({
    filteredGroups: groups,
    enrichedPayloadStr: payloadStr,
    canonicalEvent: hookEventName,
    hookEventName,
    daemonContext,
    cwd: extractCwd(payloadStr),
  })
}
