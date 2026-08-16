import { merge } from "lodash-es"
import { type HookGroup, hookIdentifier } from "../hook-types.ts"
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
  /** Parsed payload (carries `_lastUserMessageAt`/`transcript_path`) for the grace-window check. */
  graceInput: Record<string, any>
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
  const { isAutoSteerAvailable } = await import("../utils/auto-steer-helpers.ts")
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

  return { sessionId, safeSession, terminalApp, graceInput: payload }
}

async function tryOnSessionStopDelivery(enrichedPayloadStr: string): Promise<boolean> {
  const ctx = await resolveStopAutoSteerContext(enrichedPayloadStr)
  if (!ctx) return false

  const { getAutoSteerStore } = await import("../../src/auto-steer-store.ts")
  const store = getAutoSteerStore()
  if (!store.hasPending(ctx.safeSession, "on_session_stop")) return false

  const { renderQueuedAutoSteerRequest, sendAutoSteer } = await import(
    "../utils/auto-steer-helpers.ts"
  )
  const sent = new Set<string>()
  let deliveredCount = 0
  let batch = store.consumeOne(ctx.safeSession, "on_session_stop")
  while (batch.length > 0) {
    const req = batch[0]!
    deliveredCount++
    if (!sent.has(req.message)) {
      const message = await renderQueuedAutoSteerRequest(ctx.sessionId, req, ctx.graceInput)
      const ok = await sendAutoSteer(message, ctx.terminalApp)
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

  const { renderAutoSteerMessage, sendAutoSteer } = await import("../utils/auto-steer-helpers.ts")
  const message = await renderAutoSteerMessage(ctx.sessionId, blockReason, ctx.graceInput)
  const sent = await sendAutoSteer(message, ctx.terminalApp)
  if (!sent) return
  log(
    `   auto-steer: sent stop block reason to terminal (${ctx.terminalApp}) — converting to allow`
  )
  merge(finalResponse, { decision: "allow" })
}

/**
 * PostToolUse hooks are skipped entirely while a skill is recently active in
 * the current session — the agent is mid-skill and following its instructions,
 * so post-tool governance nudges are noise that derails the skill flow.
 * Fails closed (hooks run) when recency cannot be determined.
 */
export async function shouldSkipPostToolUseHooks(
  payload: Record<string, any>,
  cwd: string
): Promise<boolean> {
  try {
    const { isAnySkillRecentlyActive } = await import("../skill-utils.ts")
    return await isAnySkillRecentlyActive(payload, cwd)
  } catch {
    return false
  }
}

/**
 * PostToolUse hooks that perform real side effects (state sync, not advisory
 * context) and must keep running even during the skill-recency skip window.
 * `/commit` and `/push` are themselves skills, so suppressing these would
 * starve the IssueStore refresh exactly when it matters most.
 */
const SIDE_EFFECT_POST_TOOL_HOOKS = new Set(["posttooluse-upstream-sync-on-push.ts"])

/**
 * Reduce postToolUse groups to only side-effect hooks for the skill-recency
 * skip window. Groups left with no side-effect hooks are dropped entirely.
 * Exported for unit tests.
 */
export function keepSideEffectPostToolGroups(groups: HookGroup[]): HookGroup[] {
  const kept: HookGroup[] = []
  for (const group of groups) {
    const hooks = group.hooks.filter((h) => SIDE_EFFECT_POST_TOOL_HOOKS.has(hookIdentifier(h)))
    if (hooks.length > 0) kept.push({ ...group, hooks })
  }
  return kept
}

/** Minimum time (ms) to collect stop hook responses before processing.
 * Slower hooks (e.g. `stop-personal-repo-issues` which queries the GitHub API)
 * are valuable for long-term session guidance but get starved when a faster
 * file-based hook blocks first. This window lets all hooks race fairly. */
const STOP_COLLECTION_TIMEOUT_MS = 10_000

function applyMergedContextToResponse(
  finalResponse: HookOutput,
  contexts: string[],
  hookEventName: string
): void {
  const mergedContext = mergeHookContexts(contexts, hookEventName)
  if (mergedContext) {
    finalResponse.systemMessage = appendContext(finalResponse.systemMessage, mergedContext)

    const existingHso = mergeHookSpecificOutputClone(finalResponse, hookEventName)
    existingHso.additionalContext = mergedContext
    finalResponse.hookSpecificOutput = existingHso
  }
}

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
    executions.push(execution)
    if (execution.status === "skipped" || execution.status === "aborted") continue

    const blocked = resp ? isBlock(resp) : false
    if (blocked) {
      log(`   ✗ BLOCK from ${execution.file}`)
      execution.status = "block"

      if (!firstBlockHandled) {
        // First block: copy its entire response as the final response
        merge(finalResponse, resp)
        firstBlockHandled = true
      }
    } else {
      log(`   ✓ ${execution.file} (${resp ? "ok" : "no output"})`)
    }

    if (resp) {
      const ctx = extractContext(resp)
      if (ctx) contexts.push(ctx)
    }
  }

  applyMergedContextToResponse(finalResponse, contexts, hookEventName)
}

function processSingleStopResult(
  execution: HookExecution,
  resp: Record<string, any> | null,
  blockReasons: Array<{ file: string; reason: string }>,
  contexts: string[]
): void {
  if (execution.status === "skipped" || execution.status === "aborted") return

  if (resp && isBlock(resp)) {
    log(`   ✗ BLOCK from ${execution.file}`)
    execution.status = "block"
    const reason = (resp as { reason?: string }).reason
    if (reason) blockReasons.push({ file: execution.file, reason })
  } else {
    log(`   ✓ ${execution.file} (${resp ? "ok" : "no output"})`)
  }

  if (resp) {
    const ctx = extractContext(resp)
    if (ctx) contexts.push(ctx)
  }
}

function applyAggregatedBlockReasons(
  finalResponse: HookOutput,
  blockReasons: Array<{ file: string; reason: string }>
): void {
  if (blockReasons.length === 0) return
  finalResponse.decision = "block"
  finalResponse.reason = formatAggregatedStopReason(blockReasons)
  log(`   result: ${blockReasons.length} block(s) aggregated`)
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
    executions.push(execution)
    processSingleStopResult(execution, resp, blockReasons, contexts)
  }

  applyAggregatedBlockReasons(finalResponse, blockReasons)
  applyMergedContextToResponse(finalResponse, contexts, hookEventName)
}

async function checkPostToolUseSkillSkip(
  ctx: HookStrategyContext
): Promise<{ shortCircuit?: Record<string, any>; updatedCtx?: HookStrategyContext }> {
  if (ctx.canonicalEvent !== "postToolUse") return {}
  let payload: Record<string, any> = {}
  try {
    payload = JSON.parse(ctx.enrichedPayloadStr)
  } catch {}
  if (await shouldSkipPostToolUseHooks(payload, ctx.cwd)) {
    const sideEffectGroups = keepSideEffectPostToolGroups(ctx.filteredGroups)
    log(
      `   postToolUse: skill recently active — skipping advisory hooks` +
        (sideEffectGroups.length > 0
          ? ` (keeping ${sideEffectGroups.length} side-effect group(s))`
          : "")
    )
    if (sideEffectGroups.length === 0) {
      const response: Record<string, any> = {}
      coerceDispatchAgentEnvelopeInPlace(
        response,
        ctx.canonicalEvent,
        ctx.hookEventName,
        ctx.agentId
      )
      writeResponse(response)
      return { shortCircuit: response }
    }
    return { updatedCtx: { ...ctx, filteredGroups: sideEffectGroups } }
  }
  return {}
}

async function checkOnSessionStopShortCircuit(
  ctx: HookStrategyContext
): Promise<Record<string, any> | null> {
  if (ctx.canonicalEvent !== "stop") return null
  const shortCircuited = await tryOnSessionStopDelivery(ctx.enrichedPayloadStr)
  if (!shortCircuited) return null

  const response: Record<string, any> = {}
  normalizeStopDispatchResponseInPlace(response, ctx.hookEventName)
  coerceDispatchAgentEnvelopeInPlace(response, ctx.canonicalEvent, ctx.hookEventName, ctx.agentId)
  writeResponse(response)
  return response
}

async function resolveBlockingHumaniseParams(enrichedPayloadStr: string): Promise<{
  humaniseEnabled: boolean
  sessionId?: string
  transcriptPath?: string
  withinGrace: boolean
}> {
  let humaniseEnabled = false
  let sessionId: string | undefined
  let transcriptPath: string | undefined
  let withinGrace = false
  try {
    const payload = JSON.parse(enrichedPayloadStr)
    humaniseEnabled = payload._effectiveSettings?.humaniseAutoSteer ?? false
    sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined
    transcriptPath =
      typeof payload.transcript_path === "string" ? payload.transcript_path : undefined
    const { isWithinUserMessageGrace } = await import("../../src/tasks/task-governance-grace.ts")
    withinGrace = await isWithinUserMessageGrace(payload)
  } catch {}
  return { humaniseEnabled, sessionId, transcriptPath, withinGrace }
}

async function maybeHumaniseBlockingResponse(
  finalResponse: Record<string, any>,
  ctx: HookStrategyContext
): Promise<void> {
  const { humaniseEnabled, sessionId, transcriptPath, withinGrace } =
    await resolveBlockingHumaniseParams(ctx.enrichedPayloadStr)

  // Skip humanisation inside the post-user-message grace window so the
  // mechanical context voice stays visually distinct from the user's own
  // messages while they are actively present.
  if (!humaniseEnabled || withinGrace) return

  const rawContext = finalResponse.hookSpecificOutput?.additionalContext?.trim()
  if (!rawContext) return

  const { humaniseText, STRATEGY_HUMANISE_SYSTEM_PROMPT } = await import("../utils/humanise.ts")
  const humanised = await humaniseText(rawContext, {
    systemPrompt: STRATEGY_HUMANISE_SYSTEM_PROMPT,
    sessionId,
    transcriptPath,
  })
  finalResponse.systemMessage = humanised
  finalResponse.hookSpecificOutput.additionalContext = humanised
}

async function finalizeStopBlock(
  response: Record<string, any>,
  enrichedPayloadStr: string
): Promise<void> {
  const rawReason = (response as { reason?: string }).reason ?? ""
  if (rawReason) {
    response.reason = await compileStopReasons(rawReason)
  }
  await tryAutoSteerStopBlock(response, enrichedPayloadStr)
}

export class BlockingStrategy implements HookExecutionStrategy {
  async execute(ctx: HookStrategyContext): Promise<Record<string, any>> {
    const isStop = ctx.canonicalEvent === "stop"

    const postTool = await checkPostToolUseSkillSkip(ctx)
    if (postTool.shortCircuit) return postTool.shortCircuit
    if (postTool.updatedCtx) ctx = postTool.updatedCtx

    const onSessionStop = await checkOnSessionStopShortCircuit(ctx)
    if (onSessionStop) return onSessionStop

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
      processResults: async (results, executions) => {
        if (isStop) {
          processAggregatedStopResults(results, executions, finalResponse, ctx.hookEventName)
        } else {
          processBlockingResults(results, executions, finalResponse, ctx.hookEventName)
        }

        await maybeHumaniseBlockingResponse(finalResponse, ctx)

        if (!isBlock(finalResponse)) {
          log(`   result: all passed`)
        }
        return finalResponse
      },
    })

    if (isStop && isBlock(response)) {
      await finalizeStopBlock(response, ctx.enrichedPayloadStr)
    }

    return response
  }
}
