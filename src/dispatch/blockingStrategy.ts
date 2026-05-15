import { merge } from "lodash-es"
import type { HookOutput } from "../schemas.ts"
import { mergeHookSpecificOutputClone } from "../utils/hook-specific-output.ts"
import { orderHookContexts } from "./context-order.ts"
import { coerceDispatchAgentEnvelopeInPlace } from "./dispatch-zod-surfaces.ts"
import { extractContext, type HookExecution, isBlock, log, writeResponse } from "./engine.ts"
import type { EnrichedDispatchPayload } from "./execute.ts"
import { compileStopReasons, normalizeStopDispatchResponseInPlace } from "./stop-response.ts"
import {
  type HookExecutionStrategy,
  type HookStrategyContext,
  runStrategyPipeline,
} from "./strategy-base.ts"

const ACTION_REQUIRED_FOOTER =
  "You must act on this now. Do not try to stop again without completing the required action."

const STOP_SHIP_CHECKLIST_PREAMBLE =
  "You cannot stop until everything below is resolved. Follow the single action plan in order."

/** Resolved auto-steer context from an enriched payload. */
interface StopAutoSteerContext {
  sessionId: string
  safeSession: string
  terminalApp: string
}

function mergeHookContexts(contexts: string[], hookEventName: string): string | null {
  if (contexts.length === 0) return null
  const ordered = orderHookContexts(contexts, hookEventName)
  return ordered.join("\n\n")
}

function normalizedContextText(text: string): string {
  return text.trim().replace(/\s+/g, " ")
}

function appendContext(existing: unknown, mergedContext: string): string {
  const existingText = typeof existing === "string" ? existing.trim() : ""
  if (!existingText) return mergedContext

  const existingKey = normalizedContextText(existingText)
  const mergedKey = normalizedContextText(mergedContext)
  if (existingKey === mergedKey || existingKey.includes(mergedKey)) return existingText
  if (mergedKey.includes(existingKey)) return mergedContext
  return `${existingText}\n\n${mergedContext}`
}

function stripRepeatedStopFooter(reason: string): string {
  let text = reason.trim()
  while (text.endsWith(ACTION_REQUIRED_FOOTER)) {
    text = text.slice(0, -ACTION_REQUIRED_FOOTER.length).trim()
  }
  return text
}

function trimRepeatedStopPreamble(reason: string): string {
  const text = reason.trim()
  if (!text.startsWith(STOP_SHIP_CHECKLIST_PREAMBLE)) return text
  return text.slice(STOP_SHIP_CHECKLIST_PREAMBLE.length).trimStart()
}

function friendlyStopHookName(file: string): string {
  const base = file.split(/[\\/]/).pop()?.replace(/\.ts$/, "") ?? file
  return base.replace(/^stop-/, "").replace(/-/g, " ")
}

function formatAggregatedStopReason(blocks: Array<{ file: string; reason: string }>): string {
  const seen = new Set<string>()
  const sections: string[] = []

  for (const block of blocks) {
    const body = trimRepeatedStopPreamble(stripRepeatedStopFooter(block.reason))
    const dedupeKey = normalizedContextText(body)
    if (!body || seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    sections.push(`### ${friendlyStopHookName(block.file)}\n${body}`)
  }

  if (sections.length === 0) return ACTION_REQUIRED_FOOTER
  if (sections.length === 1) return `${sections[0]}\n\n${ACTION_REQUIRED_FOOTER}`

  return [
    `Stop is blocked by ${sections.length} checks. Resolve them in the order shown.`,
    "",
    sections.join("\n\n---\n\n"),
    "",
    ACTION_REQUIRED_FOOTER,
  ].join("\n")
}

async function resolveAutoSteerEnabled(
  payload: EnrichedDispatchPayload,
  sessionId: string
): Promise<boolean> {
  const injected = payload._effectiveSettings
  if (injected && typeof injected.autoSteer === "boolean") return injected.autoSteer
  const { isAutoSteerAvailable } = await import("../utils/hook-utils.ts")
  return (await isAutoSteerAvailable(sessionId)) !== null
}

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

async function tryOnSessionStopDelivery(enrichedPayloadStr: string): Promise<boolean> {
  const ctx = await resolveStopAutoSteerContext(enrichedPayloadStr)
  if (!ctx) return false

  const { getAutoSteerStore } = await import("../../src/auto-steer-store.ts")
  const store = getAutoSteerStore()
  if (!store.hasPending(ctx.safeSession, "on_session_stop")) return false

  const { sendAutoSteer } = await import("../utils/hook-utils.ts")
  const sent = new Set<string>()
  let deliveredCount = 0
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
  finalResponse: Record<string, any>,
  enrichedPayloadStr: string
): Promise<void> {
  const blockReason = (finalResponse as { reason?: string }).reason ?? ""
  if (!blockReason) return

  const ctx = await resolveStopAutoSteerContext(enrichedPayloadStr)
  if (!ctx) return

  const { getAutoSteerStore: getStore } = await import("../../src/auto-steer-store.ts")
  if (getStore().wasRecentlyDelivered(ctx.safeSession, blockReason, "on_session_stop")) return

  const { sendAutoSteer } = await import("../utils/hook-utils.ts")
  const sent = await sendAutoSteer(blockReason, ctx.terminalApp)
  if (!sent) return
  log(
    `   auto-steer: sent stop block reason to terminal (${ctx.terminalApp}) — converting to allow`
  )
  merge(finalResponse, { decision: "allow" })
}

/** Minimum time (ms) to collect stop hook responses before processing.
 * Slower hooks (e.g. `stop-personal-repo-issues` which queries the GitHub API)
 * are valuable for long-term session guidance but get starved when a faster
 * file-based hook blocks first. This window lets all hooks race fairly. */
export const STOP_COLLECTION_TIMEOUT_MS = 10_000

/** Process blocking hook results, collecting contexts from all hooks.
 *  For stop events: runs all hooks, forwards first block, merges all contexts.
 *  For other events: may have been aborted early, but still collects contexts
 *  from any hooks that completed before abort.
 *
 *  Exported for unit tests (see `strategies.test.ts`). */
export function processBlockingResults(
  results: Array<{ execution: HookExecution; parsed: Record<string, any> | null }>,
  executions: HookExecution[],
  finalResponse: HookOutput,
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

  const mergedContext = mergeHookContexts(contexts, hookEventName)
  if (mergedContext) {
    finalResponse.systemMessage = appendContext(finalResponse.systemMessage, mergedContext)

    const existingHso = mergeHookSpecificOutputClone(finalResponse, hookEventName)
    existingHso.additionalContext = mergedContext
    finalResponse.hookSpecificOutput = existingHso
  }
}

/**
 * Process stop hook results by aggregating ALL blocking reasons into one
 * combined response. Unlike {@link processBlockingResults} which forwards
 * only the first block, this collects every block reason so the agent sees
 * the full picture — including guidance from slower hooks that would
 * previously have been aborted.
 *
 * Exported for unit tests.
 */
export function processAggregatedStopResults(
  results: Array<{ execution: HookExecution; parsed: Record<string, any> | null }>,
  executions: HookExecution[],
  finalResponse: HookOutput,
  hookEventName: string
): void {
  const blockReasons: Array<{ file: string; reason: string }> = []
  const contexts: string[] = []

  for (const { execution, parsed: resp } of results) {
    if (execution.status === "skipped" || execution.status === "aborted") {
      executions.push(execution)
      continue
    }

    if (resp && isBlock(resp)) {
      log(`   ✗ BLOCK from ${execution.file}`)
      execution.status = "block"
      const reason = (resp as { reason?: string }).reason
      if (reason) blockReasons.push({ file: execution.file, reason })
      const ctx = extractContext(resp)
      if (ctx) contexts.push(ctx)
      executions.push(execution)
      continue
    }

    if (resp) {
      const ctx = extractContext(resp)
      if (ctx) contexts.push(ctx)
    }

    log(`   ✓ ${execution.file} (${resp ? "ok" : "no output"})`)
    executions.push(execution)
  }

  if (blockReasons.length > 0) {
    finalResponse.decision = "block"
    finalResponse.reason = formatAggregatedStopReason(blockReasons)
    log(`   result: ${blockReasons.length} block(s) aggregated`)
  }

  const mergedContext = mergeHookContexts(contexts, hookEventName)
  if (mergedContext) {
    finalResponse.systemMessage = appendContext(finalResponse.systemMessage, mergedContext)

    const existingHso = mergeHookSpecificOutputClone(finalResponse, hookEventName)
    existingHso.additionalContext = mergedContext
    finalResponse.hookSpecificOutput = existingHso
  }
}

export class BlockingStrategy implements HookExecutionStrategy {
  async execute(ctx: HookStrategyContext): Promise<Record<string, any>> {
    const { canonicalEvent, enrichedPayloadStr } = ctx
    const isStop = canonicalEvent === "stop"

    // on_session_stop: short-circuit all stop hooks if pending messages exist.
    if (isStop) {
      const shortCircuited = await tryOnSessionStopDelivery(enrichedPayloadStr)
      if (shortCircuited) {
        const response: Record<string, any> = {}
        normalizeStopDispatchResponseInPlace(response, ctx.hookEventName)
        coerceDispatchAgentEnvelopeInPlace(
          response,
          ctx.canonicalEvent,
          ctx.hookEventName,
          ctx.agentId
        )
        writeResponse(response)
        return response
      }
    }

    const finalResponse: Record<string, any> = {}

    const response = await runStrategyPipeline(ctx, {
      // Stop events: don't abort on first block — let all hooks race fairly
      // within the collection window so slower hooks get a chance to respond.
      onResult: isStop
        ? undefined
        : (result, abort) => {
            if (result.parsed && isBlock(result.parsed)) abort()
          },
      collectionTimeoutMs: isStop ? STOP_COLLECTION_TIMEOUT_MS : undefined,
      processResults: (results, executions) => {
        if (isStop) {
          processAggregatedStopResults(results, executions, finalResponse, ctx.hookEventName)
        } else {
          processBlockingResults(results, executions, finalResponse, ctx.hookEventName)
        }
        if (!isBlock(finalResponse)) {
          log(`   result: all passed`)
        }
        return finalResponse
      },
    })

    if (isStop && isBlock(response)) {
      const rawReason = (response as { reason?: string }).reason ?? ""
      if (rawReason) {
        response.reason = await compileStopReasons(rawReason)
      }
      await tryAutoSteerStopBlock(response, enrichedPayloadStr)
    }

    return response
  }
}
