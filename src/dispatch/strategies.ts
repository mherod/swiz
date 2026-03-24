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

/** Process all blocking hook results, mutating executions and finalResponse in place. */
function processBlockingResults(
  results: Array<{ execution: HookExecution; parsed: Record<string, unknown> | null }>,
  executions: HookExecution[],
  finalResponse: Record<string, unknown>,
  runAllHooks: boolean
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
      if (!runAllHooks) break
      continue
    }
    log(`   ✓ ${execution.file} (${resp ? "ok" : "no output"})`)
    executions.push(execution)
  }
}

/**
 * Blocking strategy: forwards first block; stop runs all hooks,
 * postToolUse short-circuits.
 */
class BlockingStrategy implements HookExecutionStrategy {
  async execute(ctx: HookStrategyContext): Promise<Record<string, unknown>> {
    const { filteredGroups, enrichedPayloadStr, canonicalEvent, daemonContext, cwd } = ctx

    const runAllHooks = canonicalEvent === "stop"
    const finalResponse: Record<string, unknown> = {}
    const executions: HookExecution[] = []

    // Fan out all sync hooks concurrently with async hooks; scan results in declaration order.
    // For non-stop events, use AbortController to kill remaining hooks on first block.
    // Stop hooks always run all hooks (no abort on first-block) but still respect
    // dispatch-level abort for timeout enforcement.
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
          if (!runAllHooks && result.parsed && isBlock(result.parsed)) {
            controller.abort()
          }
          return result
        })
      ),
      launchAsyncHooks(filteredGroups, enrichedPayloadStr, daemonContext, ctx.signal),
    ])

    ctx.signal?.removeEventListener("abort", onDispatchAbort)

    processBlockingResults(results, executions, finalResponse, runAllHooks)

    // Auto-steer intercept: when a stop hook blocks and auto-steer is available,
    // send the blocking reason directly to the terminal and convert to allow.
    // This happens at dispatch level so ALL stop hooks benefit automatically.
    // Uses _terminal and _effectiveSettings from the payload (injected by CLI dispatch)
    // so this works correctly even when running inside the daemon (no terminal env vars).
    if (canonicalEvent === "stop" && isBlock(finalResponse)) {
      const blockReason = (finalResponse as { reason?: string }).reason ?? ""
      if (blockReason) {
        const payload = JSON.parse(enrichedPayloadStr) as Record<string, unknown>
        const sessionId = (payload.session_id as string) ?? ""
        if (sessionId) {
          // Read autoSteer from dispatcher-injected effective settings, fall back to reading from disk.
          const injectedSettings = payload._effectiveSettings as Record<string, unknown> | undefined
          let autoSteerEnabled: boolean
          if (injectedSettings && typeof injectedSettings.autoSteer === "boolean") {
            autoSteerEnabled = injectedSettings.autoSteer
          } else {
            const { isAutoSteerAvailable } = await import("../../hooks/utils/hook-utils.ts")
            autoSteerEnabled = (await isAutoSteerAvailable(sessionId)) !== null
          }

          if (autoSteerEnabled) {
            // Read terminal from CLI-injected payload field (daemon has no terminal env vars).
            const injectedTerminal = payload._terminal as { app: string } | undefined
            const terminalApp = injectedTerminal?.app ?? null
            if (terminalApp) {
              const { sendAutoSteer } = await import("../../hooks/utils/hook-utils.ts")
              await sendAutoSteer(blockReason, terminalApp)
              log(
                `   auto-steer: sent stop block reason to terminal (${terminalApp}) — converting to allow`
              )
              delete (finalResponse as Record<string, unknown>).decision
              delete (finalResponse as Record<string, unknown>).reason
            }
          }
        }
      }
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
