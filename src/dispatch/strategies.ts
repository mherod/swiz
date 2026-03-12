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
}

/** Interface for hook execution strategies. */
export interface HookExecutionStrategy {
  execute(ctx: HookStrategyContext): Promise<Record<string, unknown>>
}

/**
 * PreToolUse strategy: short-circuits on first deny; collects and merges
 * allow-with-reason hints.
 */
class PreToolUseStrategy implements HookExecutionStrategy {
  async execute(ctx: HookStrategyContext): Promise<Record<string, unknown>> {
    const { filteredGroups, enrichedPayloadStr, daemonContext } = ctx

    await launchAsyncHooks(filteredGroups, enrichedPayloadStr, daemonContext)
    const cwd = extractCwd(enrichedPayloadStr)
    const hints: string[] = []
    const contexts: string[] = []
    const finalResponse: Record<string, unknown> = {}
    const executions: HookExecution[] = []

    // Fan out all sync hooks concurrently; scan results in declaration order.
    const entries = flatSyncHooks(filteredGroups)
    const results = await Promise.all(entries.map((e) => runEntry(e, enrichedPayloadStr, cwd)))

    for (const { execution, parsed: resp } of results) {
      if (execution.status === "skipped") {
        executions.push(execution)
        continue
      }
      if (resp && isDeny(resp)) {
        log(`   ✗ DENY from ${execution.file}`)
        execution.status = "deny"
        executions.push(execution)
        Object.assign(finalResponse, resp)
        break
      }
      if (resp) {
        const hso = resp.hookSpecificOutput as Record<string, unknown> | undefined
        const reason = extractAllowReason(resp)
        const context = extractContext(resp)
        if (hso?.permissionDecision === "allow" && (reason || context)) {
          execution.status = "allow-with-reason"
          executions.push(execution)
          if (reason) hints.push(reason)
          if (context) contexts.push(context)
          const preview = reason ?? context ?? ""
          log(`   ~ ${execution.file} (hint: ${preview.slice(0, 100)})`)
          continue
        }
      }
      log(`   ✓ ${execution.file} (${resp ? "allow" : "no output"})`)
      executions.push(execution)
    }

    if (!isDeny(finalResponse)) {
      if (hints.length > 0 || contexts.length > 0) {
        log(
          `   result: passed with ${hints.length} hint(s)` +
            (contexts.length > 0 ? ` and ${contexts.length} context(s)` : "")
        )
        Object.assign(finalResponse, {
          ...(contexts.length > 0 ? { systemMessage: contexts.join("\n\n") } : {}),
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            ...(hints.length > 0 ? { permissionDecisionReason: hints.join("\n\n") } : {}),
            ...(contexts.length > 0 ? { additionalContext: contexts.join("\n\n") } : {}),
          },
        })
      } else {
        log(`   result: all passed`)
      }
    }
    logSlowHookSummary(executions)
    if (executions.length > 0) Object.assign(finalResponse, { hookExecutions: executions })

    writeResponse(finalResponse)
    return finalResponse
  }
}

/**
 * Blocking strategy: forwards first block; stop runs all hooks,
 * postToolUse short-circuits.
 */
class BlockingStrategy implements HookExecutionStrategy {
  async execute(ctx: HookStrategyContext): Promise<Record<string, unknown>> {
    const { filteredGroups, enrichedPayloadStr, canonicalEvent, daemonContext } = ctx

    await launchAsyncHooks(filteredGroups, enrichedPayloadStr, daemonContext)
    const cwd = extractCwd(enrichedPayloadStr)
    const runAllHooks = canonicalEvent === "stop"
    const finalResponse: Record<string, unknown> = {}
    const executions: HookExecution[] = []

    // Fan out all sync hooks concurrently; scan results in declaration order.
    const entries = flatSyncHooks(filteredGroups)
    const results = await Promise.all(entries.map((e) => runEntry(e, enrichedPayloadStr, cwd)))

    for (const { execution, parsed: resp } of results) {
      if (execution.status === "skipped") {
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
    const { filteredGroups, enrichedPayloadStr, hookEventName, daemonContext } = ctx

    await launchAsyncHooks(filteredGroups, enrichedPayloadStr, daemonContext)
    const cwd = extractCwd(enrichedPayloadStr)
    const contexts: string[] = []
    const executions: HookExecution[] = []

    // All context hooks are independent — fan out fully, merge results in order.
    const entries = flatSyncHooks(filteredGroups)
    const results = await Promise.all(entries.map((e) => runEntry(e, enrichedPayloadStr, cwd)))

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
  })
}
