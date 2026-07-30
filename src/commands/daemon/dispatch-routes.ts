/**
 * Dispatch route handlers for the daemon web server.
 * Extracted from web-server.ts (issue #685) to keep routing code focused.
 */
import { join } from "node:path"
import { ZodError } from "zod"
import { debugLog } from "../../debug.ts"
import {
  DispatchPayloadValidationError,
  parseValidatedAgentDispatchWireJson,
} from "../../dispatch/dispatch-zod-surfaces.ts"
import { isBlock } from "../../dispatch/engine.ts"
import { type DispatchLifecycleUpdate, executeDispatch } from "../../dispatch/execute.ts"
import {
  schedulePayloadJsonlAppend,
  shouldCaptureIncomingPayloads,
} from "../../dispatch/incoming-capture.ts"
import { isStopLikeDispatchEvent } from "../../dispatch/stop-response.ts"
import { DISPATCH_TIMEOUTS } from "../../manifest.ts"
import { createTaskStoreForHookPayload } from "../../task-roots.ts"
import type { CurrentSessionToolUsage } from "../../transcript-summary.ts"
import { messageFromUnknownError } from "../../utils/hook-json-helpers.ts"
import type { WarmStatusLineSnapshot } from "../status-line.ts"
import type { CappedMap } from "./cache/capped-map.ts"
import { registerProjectAndTouch } from "./route-helpers.ts"
import {
  type DaemonMetrics,
  type LastUserMessageCache,
  type ManifestCache,
  recordDispatch,
  type TranscriptIndexCache,
} from "./runtime-cache.ts"
import type { ActiveHookDispatch } from "./types.ts"
import type { UpstreamSyncRegistry } from "./upstream-sync.ts"
import type { CapturedToolCall, SessionToolUsageState } from "./utils.ts"
import {
  captureSessionToolCall,
  captureSessionToolUsage,
  persistSessionToolCall,
  seedSessionToolUsage,
} from "./utils.ts"
import type { DaemonWebServerContext } from "./web-server-context.ts"
import type { DaemonWorkerRuntime } from "./worker-runtime.ts"

/** Hard request-level timeout for daemon dispatch (ms).
 *  Uses DISPATCH_TIMEOUTS + 10s grace. Fallback: 60s for unknown events. */
const DAEMON_REQUEST_TIMEOUT_GRACE_MS = 10_000
const DAEMON_REQUEST_TIMEOUT_FALLBACK_MS = 60_000

/** Maximum age before an active dispatch entry is considered stale and reaped (ms).
 *  Generous enough to cover the slowest event (stop: 180s) plus overhead. */
const STALE_DISPATCH_MAX_AGE_MS = 300_000 // 5 minutes

/**
 * Narrow context for dispatch route handlers — only the capabilities those handlers need.
 */
export interface DispatchRoutesContext {
  projectMetrics: Map<string, DaemonMetrics>
  getProjectMetrics: (cwd: string) => DaemonMetrics
  globalMetrics: DaemonMetrics
  sessionActivity: Map<string, { lastSeen: number; dispatches: number }>
  sessionToolCalls: Map<string, CapturedToolCall[]>
  sessionToolUsage: Map<string, SessionToolUsageState>
  activeHookDispatches: Map<string, ActiveHookDispatch>
  workerRuntime: DaemonWorkerRuntime
  touchProject: (cwd: string) => void
  registerProjectWatchers: (cwd: string) => void
  manifestCache: ManifestCache
  resolveSnapshot: (
    cwd: string,
    sessionId: string | null | undefined
  ) => Promise<WarmStatusLineSnapshot>
  upstreamSyncRegistry: UpstreamSyncRegistry
  transcriptIndex: TranscriptIndexCache
  lastUserMessageCache: LastUserMessageCache
  taskStateCache: import("../../tasks/task-state-cache.ts").TaskStateCache
  recentHookAllowMessages: CappedMap<string, string>
}

export function buildDispatchRoutesContext(ctx: DaemonWebServerContext): DispatchRoutesContext {
  return {
    projectMetrics: ctx.projectMetrics,
    getProjectMetrics: ctx.getProjectMetrics,
    globalMetrics: ctx.globalMetrics,
    sessionActivity: ctx.sessionActivity,
    sessionToolCalls: ctx.sessionToolCalls,
    sessionToolUsage: ctx.sessionToolUsage,
    activeHookDispatches: ctx.activeHookDispatches,
    workerRuntime: ctx.workerRuntime,
    touchProject: ctx.touchProject,
    registerProjectWatchers: ctx.registerProjectWatchers,
    manifestCache: ctx.manifestCache,
    resolveSnapshot: ctx.resolveSnapshot,
    upstreamSyncRegistry: ctx.upstreamSyncRegistry,
    transcriptIndex: ctx.transcriptIndex,
    lastUserMessageCache: ctx.lastUserMessageCache,
    taskStateCache: ctx.taskStateCache,
    recentHookAllowMessages: ctx.recentHookAllowMessages,
  }
}

function daemonDispatchRequestTimeoutMs(canonicalEvent: string): number {
  const budgetSec = DISPATCH_TIMEOUTS[canonicalEvent]
  return budgetSec
    ? budgetSec * 1000 + DAEMON_REQUEST_TIMEOUT_GRACE_MS
    : DAEMON_REQUEST_TIMEOUT_FALLBACK_MS
}

/**
 * Remove leaked entries from activeHookDispatches that are older than
 * STALE_DISPATCH_MAX_AGE_MS. Called on every incoming request as a
 * lightweight garbage collection pass.
 */
export function reapStaleDispatches(activeHookDispatches: Map<string, ActiveHookDispatch>): void {
  if (activeHookDispatches.size === 0) return
  const cutoff = Date.now() - STALE_DISPATCH_MAX_AGE_MS
  for (const [id, entry] of activeHookDispatches) {
    if (entry.startedAt < cutoff) {
      activeHookDispatches.delete(id)
    }
  }
}

function trimHookText(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function extractHookAllowMessage(response: Record<string, any>): string | null {
  const hookSpecificOutput = response.hookSpecificOutput
  const output =
    hookSpecificOutput &&
    typeof hookSpecificOutput === "object" &&
    !Array.isArray(hookSpecificOutput)
      ? (hookSpecificOutput as Record<string, unknown>)
      : undefined

  const additionalContext = trimHookText(output?.additionalContext)
  const systemMessage = trimHookText(response.systemMessage)
  const reason = trimHookText(response.reason)
  const stopReason = trimHookText(response.stopReason)
  const permissionDecisionReason = trimHookText(output?.permissionDecisionReason)
  if (
    additionalContext === null &&
    systemMessage === null &&
    reason === null &&
    stopReason === null &&
    permissionDecisionReason === null
  ) {
    return null
  }
  return JSON.stringify({
    additionalContext,
    systemMessage,
    reason,
    stopReason,
    permissionDecisionReason,
  })
}

function stripDuplicateAllowMessage(response: Record<string, any>): void {
  delete response.systemMessage
  delete response.reason
  delete response.stopReason

  const hookSpecificOutput = response.hookSpecificOutput
  if (
    hookSpecificOutput &&
    typeof hookSpecificOutput === "object" &&
    !Array.isArray(hookSpecificOutput)
  ) {
    const output = hookSpecificOutput as Record<string, unknown>
    delete output.additionalContext
    delete output.permissionDecisionReason
    if (Object.keys(output).length === 0) {
      delete response.hookSpecificOutput
    }
  }
}

function dedupeHookAllowMessageKey(
  payload: Record<string, unknown> | null,
  canonicalEvent: string,
  hookEventName: string
): string {
  const sessionId = typeof payload?.session_id === "string" ? payload.session_id : "none"
  const cwd = typeof payload?.cwd === "string" ? payload.cwd : "none"
  const toolName =
    typeof payload?.tool_name === "string"
      ? payload.tool_name
      : typeof payload?.toolName === "string"
        ? payload.toolName
        : "none"
  return `${canonicalEvent}|${hookEventName}|${cwd}|${sessionId}|${toolName}`
}

function maybeSuppressDuplicateAllowMessage(
  ctx: DispatchRoutesContext,
  payload: Record<string, unknown> | null,
  canonicalEvent: string,
  hookEventName: string,
  response: Record<string, any>
): void {
  if (isStopLikeDispatchEvent(canonicalEvent)) return
  if (isBlock(response)) return

  const message = extractHookAllowMessage(response)
  if (message === null) return

  const key = dedupeHookAllowMessageKey(payload, canonicalEvent, hookEventName)
  const last = ctx.recentHookAllowMessages.get(key)
  if (last === message) {
    stripDuplicateAllowMessage(response)
    return
  }

  ctx.recentHookAllowMessages.set(key, message)
}

function createDispatchLifecycleHandler(
  ctx: DispatchRoutesContext
): (update: DispatchLifecycleUpdate) => void {
  return (update) => {
    if (update.phase === "start") {
      ctx.activeHookDispatches.set(update.requestId, {
        requestId: update.requestId,
        canonicalEvent: update.canonicalEvent,
        hookEventName: update.hookEventName,
        cwd: update.cwd,
        sessionId: update.sessionId,
        hooks: update.hooks,
        startedAt: update.startedAt,
        toolName: update.toolName,
        toolInputSummary: update.toolInputSummary,
      })
      return
    }
    ctx.activeHookDispatches.delete(update.requestId)
  }
}

async function updateParsedPayloadMetrics(
  ctx: DispatchRoutesContext,
  payloadStr: string,
  canonicalEvent: string,
  durationMs: number
): Promise<void> {
  const parsed = await ctx.workerRuntime.parseDispatchPayload(payloadStr)
  if (!parsed) return

  const nowMs = Date.now()
  if (parsed.cwd) {
    const projectCwd = await registerProjectAndTouch(ctx, parsed.cwd)
    if (projectCwd) {
      recordDispatch(ctx.getProjectMetrics(projectCwd), canonicalEvent, durationMs)
    }
  }
  if (parsed.sessionId) {
    const prev = ctx.sessionActivity.get(parsed.sessionId)
    ctx.sessionActivity.set(parsed.sessionId, {
      lastSeen: nowMs,
      dispatches: (prev?.dispatches ?? 0) + 1,
    })
    if (canonicalEvent === "userPromptSubmit") {
      ctx.lastUserMessageCache.recordFromHook(parsed.sessionId, nowMs)
    }
    if (canonicalEvent === "preToolUse" && parsed.toolName) {
      captureSessionToolCall(
        ctx.sessionToolCalls,
        parsed.sessionId,
        parsed.toolName,
        parsed.toolInput,
        nowMs
      )
      if (parsed.cwd) {
        try {
          await persistSessionToolCall(
            parsed.cwd,
            parsed.sessionId,
            parsed.toolName,
            parsed.toolInput,
            nowMs
          )
        } catch (error) {
          debugLog(
            `[daemon] failed to persist session tool call for ${parsed.sessionId}: ${messageFromUnknownError(
              error
            )}`
          )
        }
      }
      captureSessionToolUsage(
        ctx.sessionToolUsage,
        parsed.sessionId,
        parsed.toolName,
        parsed.toolInput,
        nowMs
      )
    }
  }
}

async function getCurrentSessionToolUsageFromDaemon(
  ctx: DispatchRoutesContext,
  sessionId: string,
  transcriptPath?: string
): Promise<CurrentSessionToolUsage | null> {
  const cached = ctx.sessionToolUsage.get(sessionId)
  if (cached) {
    cached.lastSeen = Date.now()
    return {
      toolNames: [...cached.toolNames],
      skillInvocations: [...cached.skillInvocations],
      events: cached.events ? [...cached.events] : undefined,
    }
  }

  if (!transcriptPath) return null
  const index = await ctx.transcriptIndex.get(transcriptPath)
  if (!index) return null
  const seeded = seedSessionToolUsage(ctx.sessionToolUsage, sessionId, index.summary, Date.now())
  return {
    toolNames: [...seeded.toolNames],
    skillInvocations: [...seeded.skillInvocations],
    events: seeded.events ? [...seeded.events] : undefined,
  }
}

/** Maps dispatch validation failures to HTTP — always includes Zod `issues` when available. */
function daemonDispatchSchemaFailureResponse(e: unknown): Response | null {
  if (e instanceof DispatchPayloadValidationError) {
    return Response.json({ error: e.message, issues: e.zodError.issues }, { status: 400 })
  }
  if (e instanceof ZodError) {
    debugLog("[daemon] dispatch Zod validation failed:", e.issues)
    return Response.json(
      { error: "Dispatch schema validation failed", issues: e.issues },
      { status: 422 }
    )
  }
  return null
}

export async function handleDispatchRoute(
  req: Request,
  url: URL,
  ctx: DispatchRoutesContext
): Promise<Response> {
  const canonicalEvent = url.searchParams.get("event")
  const hookEventName = url.searchParams.get("hookEventName") ?? canonicalEvent
  if (!canonicalEvent || !hookEventName) {
    return Response.json({ error: "Missing required query param: event" }, { status: 400 })
  }
  const payloadStr = await req.text()
  const start = performance.now()
  let parsedPayload: Record<string, unknown> | null = null

  // Register fs.watch and seed in-memory event state for this session's task
  // directory so both TaskStateCache and task-count-context have accurate data
  // from the very first tool call in the session.
  try {
    parsedPayload = JSON.parse(payloadStr) as Record<string, unknown>
    const sessionId = typeof parsedPayload.session_id === "string" ? parsedPayload.session_id : null
    if (sessionId && ctx.taskStateCache) {
      const { tasksDir } = createTaskStoreForHookPayload(parsedPayload)
      const sessionTasksDir = join(tasksDir, sessionId)
      ctx.taskStateCache.watchSession(sessionId, sessionTasksDir)
      const { seedSessionFromDisk } = await import("../../tasks/task-event-state.ts")
      await seedSessionFromDisk(sessionId, sessionTasksDir)
    }
    if (parsedPayload && hookEventName && shouldCaptureIncomingPayloads()) {
      schedulePayloadJsonlAppend(hookEventName, parsedPayload as Record<string, any>)
    }
  } catch {
    // Best-effort — don't block dispatch if payload parsing or seeding fails
  }

  const requestTimeoutMs = daemonDispatchRequestTimeoutMs(canonicalEvent)

  // Daemon-level AbortController — when the request timeout fires, this
  // signal propagates through executeDispatch → strategy → individual hooks,
  // ensuring all spawned processes are SIGTERM'd instead of orphaned.
  const requestAbort = new AbortController()

  const TIMEOUT_SENTINEL = Symbol("timeout")
  const requestTimer = setTimeout(() => requestAbort.abort(), requestTimeoutMs)

  let raceResult: Awaited<ReturnType<typeof executeDispatch>> | typeof TIMEOUT_SENTINEL
  try {
    raceResult = await Promise.race([
      executeDispatch({
        canonicalEvent,
        hookEventName,
        payloadStr,
        daemonContext: true,
        signal: requestAbort.signal,
        currentSessionToolUsageProvider: async (sessionId, transcriptPath) =>
          getCurrentSessionToolUsageFromDaemon(ctx, sessionId, transcriptPath),
        lastUserMessageAtProvider: (sessionId) =>
          ctx.lastUserMessageCache.peek(sessionId)?.at ?? null,
        disableTranscriptSummaryFallback: true,
        manifestProvider: async (cwd) => ctx.manifestCache.get(cwd),
        onDispatchLifecycle: createDispatchLifecycleHandler(ctx),
      }),
      new Promise<typeof TIMEOUT_SENTINEL>((resolve) =>
        setTimeout(() => resolve(TIMEOUT_SENTINEL), requestTimeoutMs)
      ),
    ])
  } catch (e) {
    clearTimeout(requestTimer)
    const durationMs = performance.now() - start
    recordDispatch(ctx.globalMetrics, canonicalEvent, durationMs)
    const schemaResp = daemonDispatchSchemaFailureResponse(e)
    if (schemaResp) return schemaResp
    throw e
  }

  clearTimeout(requestTimer)

  if (raceResult === TIMEOUT_SENTINEL) {
    // Ensure abort fires even if timer callback hasn't executed yet.
    if (!requestAbort.signal.aborted) requestAbort.abort()
    const durationMs = performance.now() - start
    recordDispatch(ctx.globalMetrics, canonicalEvent, durationMs)
    return Response.json(
      {
        error: `Dispatch timeout: ${canonicalEvent} exceeded ${requestTimeoutMs}ms`,
        timedOut: true,
      },
      { status: 504 }
    )
  }

  const durationMs = performance.now() - start
  recordDispatch(ctx.globalMetrics, canonicalEvent, durationMs)
  await updateParsedPayloadMetrics(ctx, payloadStr, canonicalEvent, durationMs)

  try {
    const response = parseValidatedAgentDispatchWireJson(
      raceResult.response,
      canonicalEvent,
      hookEventName
    )
    maybeSuppressDuplicateAllowMessage(ctx, parsedPayload, canonicalEvent, hookEventName, response)
    return Response.json(response)
  } catch (e) {
    const schemaResp = daemonDispatchSchemaFailureResponse(e)
    if (schemaResp) return schemaResp
    throw e
  }
}

export function handleDispatchActive(url: URL, ctx: DispatchRoutesContext): Response {
  const cwd = url.searchParams.get("cwd")
  const sessionId = url.searchParams.get("sessionId")
  const active = [...ctx.activeHookDispatches.values()]
    .filter((entry) => (!cwd || entry.cwd === cwd) && (!sessionId || entry.sessionId === sessionId))
    .sort((a, b) => b.startedAt - a.startedAt)
  return Response.json({ active })
}
