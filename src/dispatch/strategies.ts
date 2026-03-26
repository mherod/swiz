import type { HookGroup } from "../manifest.ts"
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
  const hso = resp.hookSpecificOutput as Record<string, unknown> | undefined
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
    return {}
  }
  log(
    `   result: passed with ${hints.length} hint(s)` +
      (contexts.length > 0 ? ` and ${contexts.length} context(s)` : "")
  )
  return {
    ...(contexts.length > 0 ? { systemMessage: contexts.join("\n\n") } : {}),
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      ...(hints.length > 0 ? { permissionDecisionReason: hints.join("\n\n") } : {}),
      ...(contexts.length > 0 ? { additionalContext: contexts.join("\n\n") } : {}),
    },
  }
}

class PreToolUseStrategy implements HookExecutionStrategy {
  async execute(ctx: HookStrategyContext): Promise<Record<string, unknown>> {
    const { filteredGroups, enrichedPayloadStr, daemonContext, cwd } = ctx

    const hints: string[] = []
    const contexts: string[] = []
    const finalResponse: Record<string, unknown> = {}
    const executions: HookExecution[] = []

    const entries = flatSyncHooks(filteredGroups)
    // AbortController allows early termination: when one hook denies OR the
    // dispatch-level timeout fires, all running hook processes are killed
    // immediately. Each hook checks the signal before spawning and listens
    // for abort to kill its subprocess mid-flight.
    const controller = new AbortController()
    const { signal } = controller

    // If the dispatch-level signal fires, propagate abort to our local controller.
    const onDispatchAbort = () => controller.abort()
    ctx.signal?.addEventListener("abort", onDispatchAbort, { once: true })

    // Run async hooks concurrently with sync hooks — in daemon context this avoids
    // blocking the sync fan-out until all async hooks complete.
    const [results] = await Promise.all([
      Promise.all(
        entries.map(async (e) => {
          const result = await runEntry(e, enrichedPayloadStr, cwd, signal)
          // If this hook denied, abort all other running hooks immediately.
          if (result.parsed && isDeny(result.parsed)) {
            controller.abort()
          }
          return result
        })
      ),
      launchAsyncHooks(filteredGroups, enrichedPayloadStr, daemonContext, ctx.signal),
    ])

    ctx.signal?.removeEventListener("abort", onDispatchAbort)

    for (const { execution, parsed: resp } of results) {
      if (execution.status === "skipped" || execution.status === "aborted") {
        executions.push(execution)
        continue
      }
      const classification = classifyPreToolResult(execution, resp, hints, contexts)
      executions.push(execution)
      if (classification === "deny") {
        Object.assign(finalResponse, resp)
        break
      }
    }

    if (!isDeny(finalResponse)) {
      Object.assign(finalResponse, buildPreToolResponse(hints, contexts))
    }
    logSlowHookSummary(executions)
    if (executions.length > 0) Object.assign(finalResponse, { hookExecutions: executions })

    writeResponse(finalResponse)
    return finalResponse
  }
}

/** Process blocking hook results, short-circuiting on first block. */
function processBlockingResults(
  results: Array<{ execution: HookExecution; parsed: Record<string, unknown> | null }>,
  executions: HookExecution[],
  finalResponse: Record<string, unknown>
): void {
  for (const { execution, parsed: resp } of results) {
    if (execution.status === "skipped" || execution.status === "aborted") {
      executions.push(execution)
      continue
    }
    if (resp && isBlock(resp)) {
      log(`   ✗ BLOCK from ${execution.file}`)
      execution.status = "block"
      executions.push(execution)
      // Keep the first block response exactly as produced.
      if (!isBlock(finalResponse)) Object.assign(finalResponse, resp)
      break
    }
    log(`   ✓ ${execution.file} (${resp ? "ok" : "no output"})`)
    executions.push(execution)
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
  const { isAutoSteerAvailable } = await import("../../hooks/utils/hook-utils.ts")
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

  const { sendAutoSteer } = await import("../../hooks/utils/hook-utils.ts")
  const requests = store.consume(ctx.safeSession, "on_session_stop")
  const sent = new Set<string>()
  for (const req of requests) {
    if (sent.has(req.message)) continue
    const ok = await sendAutoSteer(req.message, ctx.terminalApp)
    if (ok) {
      log(`   auto-steer: delivered on_session_stop message to terminal (${ctx.terminalApp})`)
    }
    sent.add(req.message)
  }
  log(`   on_session_stop: short-circuited ${requests.length} message(s) — skipping stop hooks`)
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

  const { sendAutoSteer } = await import("../../hooks/utils/hook-utils.ts")
  const sent = await sendAutoSteer(blockReason, ctx.terminalApp)
  if (!sent) return
  log(
    `   auto-steer: sent stop block reason to terminal (${ctx.terminalApp}) — converting to allow`
  )
  delete finalResponse.decision
  delete finalResponse.reason
}

class BlockingStrategy implements HookExecutionStrategy {
  async execute(ctx: HookStrategyContext): Promise<Record<string, unknown>> {
    const { filteredGroups, enrichedPayloadStr, canonicalEvent, daemonContext, cwd } = ctx

    // on_session_stop: short-circuit all stop hooks if pending messages exist.
    // Deliver queued messages and return immediately — stop won't actually happen,
    // so running the full hook chain is unnecessary.
    if (canonicalEvent === "stop") {
      const shortCircuited = await tryOnSessionStopDelivery(enrichedPayloadStr)
      if (shortCircuited) {
        const response: Record<string, unknown> = {}
        writeResponse(response)
        return response
      }
    }

    const finalResponse: Record<string, unknown> = {}
    const executions: HookExecution[] = []

    // Fan out all sync hooks concurrently with async hooks; scan results in declaration order.
    // AbortController kills remaining hooks on first block (including stop events)
    // and also fires on dispatch-level timeout.
    const entries = flatSyncHooks(filteredGroups)
    const controller = new AbortController()
    const { signal } = controller

    // Propagate dispatch-level abort to our local controller.
    const onDispatchAbort = () => controller.abort()
    ctx.signal?.addEventListener("abort", onDispatchAbort, { once: true })

    const [results] = await Promise.all([
      Promise.all(
        entries.map(async (e) => {
          // For stop events, only abort on dispatch-level timeout (not first-block).
          // For other blocking events, also abort on first block.
          const result = await runEntry(e, enrichedPayloadStr, cwd, signal)
          if (result.parsed && isBlock(result.parsed)) {
            controller.abort()
          }
          return result
        })
      ),
      launchAsyncHooks(filteredGroups, enrichedPayloadStr, daemonContext, ctx.signal),
    ])

    ctx.signal?.removeEventListener("abort", onDispatchAbort)

    processBlockingResults(results, executions, finalResponse)

    if (canonicalEvent === "stop" && isBlock(finalResponse)) {
      await tryAutoSteerStopBlock(finalResponse, enrichedPayloadStr)
    }

    if (!isBlock(finalResponse)) {
      log(`   result: all passed`)
    }
    logSlowHookSummary(executions)
    if (executions.length > 0) Object.assign(finalResponse, { hookExecutions: executions })

    writeResponse(finalResponse)
    return finalResponse
  }
}

/**
 * Context strategy: runs all hooks, merges additionalContext for
 * sessionStart and userPromptSubmit events.
 */
class ContextStrategy implements HookExecutionStrategy {
  async execute(ctx: HookStrategyContext): Promise<Record<string, unknown>> {
    const { filteredGroups, enrichedPayloadStr, hookEventName, daemonContext, cwd } = ctx

    const contexts: string[] = []
    const executions: HookExecution[] = []

    // All context hooks are independent — fan out fully, merge results in order.
    // Async hooks run concurrently with the sync fan-out.
    // Dispatch-level abort signal is passed through for timeout enforcement.
    const entries = flatSyncHooks(filteredGroups)
    const [results] = await Promise.all([
      Promise.all(entries.map((e) => runEntry(e, enrichedPayloadStr, cwd, ctx.signal))),
      launchAsyncHooks(filteredGroups, enrichedPayloadStr, daemonContext, ctx.signal),
    ])

    for (const { execution, parsed: resp } of results) {
      if (execution.status === "skipped") {
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

    const finalResponse: Record<string, unknown> = {}

    if (contexts.length === 0) {
      log(`   result: no contexts to merge`)
    } else {
      log(`   result: merged ${contexts.length} context(s), hookEventName=${hookEventName}`)
      Object.assign(finalResponse, {
        hookSpecificOutput: {
          hookEventName,
          additionalContext: contexts.join("\n\n"),
        },
      })
    }
    logSlowHookSummary(executions)
    if (executions.length > 0) Object.assign(finalResponse, { hookExecutions: executions })

    writeResponse(finalResponse)
    return finalResponse
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
