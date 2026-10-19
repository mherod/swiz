/** HTTP adapter for dispatch; execution and session policy live in dedicated modules. */
import { ZodError } from "zod"
import { debugLog } from "../../debug.ts"
import { ensureDispatchId } from "../../dispatch/dispatch-id.ts"
import {
  DispatchPayloadValidationError,
  parseValidatedAgentDispatchWireJson,
} from "../../dispatch/dispatch-zod-surfaces.ts"
import { type DispatchResult, executeDispatch } from "../../dispatch/execute.ts"
import {
  scheduleIncomingDispatchCapture,
  schedulePayloadJsonlAppend,
  scheduleStaleIncomingCapturePrune,
  shouldCaptureIncomingPayloads,
} from "../../dispatch/incoming-capture.ts"
import { DISPATCH_ROUTES } from "../../dispatch/index.ts"
import { DISPATCH_TIMEOUTS } from "../../dispatch/timeouts.ts"
import type { DispatchStageDurations } from "../../dispatch/timing.ts"
import { createTaskStoreForHookPayload } from "../../task-roots.ts"
import { sessionDirPath, sessionStoreKey } from "../../tasks/task-store-path.ts"
import { type DispatchRequestScope, withDispatchRequestScope } from "./dispatch-request-scope.ts"
import {
  createDispatchLifecycleHandler,
  type DispatchSessionContext,
  getCurrentSessionToolUsageFromDaemon,
  type LifecycleTaskDispatchPreparation,
  maybeSuppressDuplicateAllowMessage,
  prepareLifecycleTaskDispatch,
  updateParsedPayloadMetrics,
} from "./dispatch-session.ts"
import {
  type DaemonMetrics,
  type DispatchOutcome,
  type ManifestCache,
  type RepositoryCapabilityCache,
  recordDispatch,
} from "./runtime-cache.ts"
import type { ActiveHookDispatch } from "./types.ts"
import type { DaemonWebServerContext } from "./web-server-context.ts"

export {
  maybeSuppressDuplicateAllowMessage,
  prepareLifecycleTaskDispatch,
} from "./dispatch-session.ts"

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
export interface DispatchRoutesContext extends DispatchSessionContext {
  projectMetrics: Map<string, DaemonMetrics>
  globalMetrics: DaemonMetrics
  manifestCache: ManifestCache
  repositoryCapabilityCache: RepositoryCapabilityCache
  taskStateCache: import("../../tasks/task-state-cache.ts").TaskStateCache
}

export function buildDispatchRoutesContext(ctx: DaemonWebServerContext): DispatchRoutesContext {
  return {
    projectMetrics: ctx.projectMetrics,
    getProjectMetrics: ctx.getProjectMetrics,
    globalMetrics: ctx.globalMetrics,
    sessionActivity: ctx.sessionActivity,
    sessionToolCalls: ctx.sessionToolCalls,
    sessionToolUsage: ctx.sessionToolUsage,
    sessionDivergence: ctx.sessionDivergence,
    activeHookDispatches: ctx.activeHookDispatches,
    workerRuntime: ctx.workerRuntime,
    touchProject: ctx.touchProject,
    registerProjectWatchers: ctx.registerProjectWatchers,
    manifestCache: ctx.manifestCache,
    repositoryCapabilityCache: ctx.repositoryCapabilityCache,
    transcriptIndex: ctx.transcriptIndex,
    lastUserMessageCache: ctx.lastUserMessageCache,
    taskStateCache: ctx.taskStateCache,
    lifecycleTaskRegistry: ctx.lifecycleTaskRegistry,
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

function clientBootstrapDurationMs(payload: Record<string, unknown> | null): number | undefined {
  const timing = payload?._swizTiming
  if (!timing || typeof timing !== "object" || Array.isArray(timing)) return undefined
  const duration = (timing as Record<string, unknown>).cliBootstrapMs
  return typeof duration === "number" && Number.isFinite(duration) && duration >= 0
    ? duration
    : undefined
}

function createDispatchMetricRecorder(options: {
  ctx: DispatchRoutesContext
  canonicalEvent: string
  fallbackRoute: string
  requestStartedAt: number
  captureMs: number
  cliBootstrapMs: number | undefined
}): (
  result: DispatchResult | null,
  projectMetrics: DaemonMetrics | null,
  outcome: DispatchOutcome,
  persistenceMs?: number
) => void {
  const { ctx, canonicalEvent, fallbackRoute, requestStartedAt, captureMs, cliBootstrapMs } =
    options
  const baseStages: DispatchStageDurations = {
    capture: captureMs,
    ...(cliBootstrapMs === undefined ? {} : { cliBootstrap: cliBootstrapMs }),
  }
  let recorded = false
  return (result, projectMetrics, outcome, persistenceMs) => {
    if (recorded) return
    recorded = true
    const stages: DispatchStageDurations = {
      ...baseStages,
      ...(result?.timing.stages ?? {}),
      ...(persistenceMs === undefined ? {} : { persistence: persistenceMs }),
    }
    const options = {
      route: result?.timing.route ?? fallbackRoute,
      outcome,
      stages,
      hookCount: result?.timing.hookCount ?? 0,
    } as const
    const durationMs = performance.now() - requestStartedAt
    recordDispatch(ctx.globalMetrics, canonicalEvent, durationMs, options)
    if (projectMetrics) recordDispatch(projectMetrics, canonicalEvent, durationMs, options)
  }
}

function dispatchOutcome(response: Record<string, any>): DispatchOutcome {
  const error = typeof response.error === "string" ? response.error : ""
  if (error.toLowerCase().includes("timeout")) return "timeout"
  return error ? "error" : "success"
}

interface PreparedDaemonDispatchPayload {
  dispatchPayloadStr: string
  parsedPayload: Record<string, unknown> | null
  lifecyclePreparation: LifecycleTaskDispatchPreparation
}

interface ParsedDaemonPayload {
  dispatchIdAdded: boolean
  parsedPayload: Record<string, unknown> | null
}

function parseDaemonPayload(
  payloadStr: string,
  canonicalEvent: string,
  hookEventName: string
): ParsedDaemonPayload {
  try {
    const parsed: unknown = JSON.parse(payloadStr)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Dispatch payload must be a JSON object")
    }
    const parsedPayload = parsed as Record<string, unknown>
    const existingDispatchId = parsedPayload._swizDispatchId
    ensureDispatchId(parsedPayload)
    return {
      dispatchIdAdded: parsedPayload._swizDispatchId !== existingDispatchId,
      parsedPayload,
    }
  } catch {
    if (shouldCaptureIncomingPayloads()) {
      scheduleIncomingDispatchCapture({
        canonicalEvent,
        hookEventName,
        parseError: true,
        payloadStr,
        incomingBeforeNormalize: null,
        normalizedPayload: {},
      })
    }
    return { dispatchIdAdded: false, parsedPayload: null }
  }
}

async function seedTaskStateAndCapturePayload(
  ctx: DispatchRoutesContext,
  hookEventName: string,
  parsedPayload: Record<string, unknown>,
  signal: AbortSignal
): Promise<void> {
  try {
    const sessionId = typeof parsedPayload.session_id === "string" ? parsedPayload.session_id : null
    if (sessionId && ctx.taskStateCache) {
      const { tasksDir } = createTaskStoreForHookPayload(parsedPayload)
      // session_id is raw hook stdin here. The surrounding catch already swallows failures as
      // best-effort seeding, so a traversing id simply seeds nothing.
      const sessionTasksDir = sessionDirPath(sessionStoreKey(sessionId), tasksDir)
      ctx.taskStateCache.watchSession(sessionId, sessionTasksDir)
      const { seedSessionFromDisk } = await import("../../tasks/task-event-state.ts")
      signal.throwIfAborted()
      await seedSessionFromDisk(sessionId, sessionTasksDir)
    }
    signal.throwIfAborted()
    if (shouldCaptureIncomingPayloads()) {
      schedulePayloadJsonlAppend(hookEventName, parsedPayload as Record<string, any>)
    }
  } catch {
    // Best-effort — task-state seeding and diagnostic JSONL must not block dispatch.
  }
}

async function prepareDaemonDispatchPayload(
  req: Request,
  hookEventName: string,
  canonicalEvent: string,
  ctx: DispatchRoutesContext,
  signal: AbortSignal
): Promise<PreparedDaemonDispatchPayload> {
  const payloadStr = await req.text()
  signal.throwIfAborted()
  const { parsedPayload, dispatchIdAdded } = parseDaemonPayload(
    payloadStr,
    canonicalEvent,
    hookEventName
  )
  if (parsedPayload) await seedTaskStateAndCapturePayload(ctx, hookEventName, parsedPayload, signal)
  signal.throwIfAborted()

  const lifecyclePreparation = await prepareLifecycleTaskDispatch(
    ctx,
    canonicalEvent,
    parsedPayload,
    signal
  )
  return {
    dispatchPayloadStr:
      (lifecyclePreparation.payloadChanged || dispatchIdAdded) && parsedPayload
        ? JSON.stringify(parsedPayload)
        : payloadStr,
    parsedPayload,
    lifecyclePreparation,
  }
}

async function executeDaemonDispatch(options: {
  canonicalEvent: string
  ctx: DispatchRoutesContext
  dispatchPayloadStr: string
  hookEventName: string
  scope: DispatchRequestScope
  lifecycleStopAdvisory?: string
}): Promise<DispatchResult> {
  const { canonicalEvent, ctx, dispatchPayloadStr, hookEventName, scope } = options
  scope.signal.throwIfAborted()
  const lifecycle = createDispatchLifecycleHandler(ctx, scope.signal)
  try {
    return await executeDispatch({
      canonicalEvent,
      hookEventName,
      payloadStr: dispatchPayloadStr,
      daemonContext: true,
      lifecycleStopAdvisory: options.lifecycleStopAdvisory,
      signal: scope.signal,
      transcriptSummaryProvider: (transcriptPath) => ctx.transcriptIndex.getSummary(transcriptPath),
      currentSessionToolUsageProvider: async (sessionId, transcriptPath) =>
        getCurrentSessionToolUsageFromDaemon(ctx, sessionId, transcriptPath, scope.signal),
      lastUserMessageAtProvider: (sessionId) =>
        ctx.lastUserMessageCache.peek(sessionId)?.at ?? null,
      disableTranscriptSummaryFallback: true,
      manifestProvider: async (cwd) => ctx.manifestCache.get(cwd),
      repositoryCapabilityProvider: async (cwd) => ctx.repositoryCapabilityCache.get(cwd),
      onDispatchLifecycle: lifecycle.onLifecycle,
    })
  } finally {
    lifecycle.dispose()
  }
}

function dispatchTimeoutResponse(
  canonicalEvent: string,
  requestTimeoutMs: number,
  recordCompletedDispatch: ReturnType<typeof createDispatchMetricRecorder>
): Response {
  const response = Response.json(
    {
      error: `Dispatch timeout: ${canonicalEvent} exceeded ${requestTimeoutMs}ms`,
      timedOut: true,
    },
    { status: 504 }
  )
  recordCompletedDispatch(null, null, "timeout")
  return response
}

async function completeDaemonDispatch(options: {
  canonicalEvent: string
  ctx: DispatchRoutesContext
  hookEventName: string
  parsedPayload: Record<string, unknown> | null
  raceResult: DispatchResult
  recordCompletedDispatch: ReturnType<typeof createDispatchMetricRecorder>
  dispatchPayloadStr: string
  scope: DispatchRequestScope
}): Promise<Response> {
  const {
    canonicalEvent,
    ctx,
    dispatchPayloadStr,
    hookEventName,
    parsedPayload,
    raceResult,
    recordCompletedDispatch,
    scope,
  } = options
  const persistenceStartedAt = performance.now()
  scope.signal.throwIfAborted()
  const projectMetrics = await updateParsedPayloadMetrics(
    ctx,
    dispatchPayloadStr,
    canonicalEvent,
    scope
  )
  scope.signal.throwIfAborted()

  try {
    const response = parseValidatedAgentDispatchWireJson(
      raceResult.response,
      canonicalEvent,
      hookEventName
    )
    maybeSuppressDuplicateAllowMessage(ctx, parsedPayload, canonicalEvent, hookEventName, response)
    if (shouldCaptureIncomingPayloads()) scheduleStaleIncomingCapturePrune()
    const httpResponse = Response.json(response)
    const persistenceMs = performance.now() - persistenceStartedAt
    recordCompletedDispatch(
      raceResult,
      projectMetrics,
      dispatchOutcome(raceResult.response),
      persistenceMs
    )
    return httpResponse
  } catch (error) {
    const schemaResponse = daemonDispatchSchemaFailureResponse(error)
    const persistenceMs = performance.now() - persistenceStartedAt
    recordCompletedDispatch(raceResult, projectMetrics, "error", persistenceMs)
    if (schemaResponse) return schemaResponse
    throw error
  }
}

export async function handleDispatchRoute(
  req: Request,
  url: URL,
  ctx: DispatchRoutesContext
): Promise<Response> {
  const requestStartedAt = performance.now()
  const canonicalEvent = url.searchParams.get("event")
  const hookEventName = url.searchParams.get("hookEventName") ?? canonicalEvent
  if (!canonicalEvent || !hookEventName) {
    return Response.json({ error: "Missing required query param: event" }, { status: 400 })
  }
  const fallbackRoute = DISPATCH_ROUTES[canonicalEvent] ?? "blocking"
  const requestTimeoutMs = daemonDispatchRequestTimeoutMs(canonicalEvent)
  let recordCompletedDispatch = createDispatchMetricRecorder({
    ctx,
    canonicalEvent,
    fallbackRoute,
    requestStartedAt,
    captureMs: 0,
    cliBootstrapMs: undefined,
  })
  try {
    const result = await withDispatchRequestScope(req.signal, requestTimeoutMs, async (scope) => {
      const { dispatchPayloadStr, parsedPayload, lifecyclePreparation } =
        await prepareDaemonDispatchPayload(req, hookEventName, canonicalEvent, ctx, scope.signal)
      scope.signal.throwIfAborted()
      recordCompletedDispatch = createDispatchMetricRecorder({
        ctx,
        canonicalEvent,
        fallbackRoute,
        requestStartedAt,
        captureMs: performance.now() - requestStartedAt,
        cliBootstrapMs: clientBootstrapDurationMs(parsedPayload),
      })
      if (lifecyclePreparation.failOpen) {
        recordCompletedDispatch(null, null, "success")
        return Response.json({})
      }
      const raceResult = await executeDaemonDispatch({
        canonicalEvent,
        ctx,
        dispatchPayloadStr,
        hookEventName,
        scope,
        lifecycleStopAdvisory: lifecyclePreparation.advisory,
      })
      return completeDaemonDispatch({
        canonicalEvent,
        ctx,
        dispatchPayloadStr,
        hookEventName,
        parsedPayload,
        raceResult,
        recordCompletedDispatch,
        scope,
      })
    })
    if (result.kind === "completed") return result.value
    if (result.kind === "timeout") {
      return dispatchTimeoutResponse(canonicalEvent, requestTimeoutMs, recordCompletedDispatch)
    }
    recordCompletedDispatch(null, null, "error")
    return Response.json({ error: "Dispatch request cancelled" }, { status: 499 })
  } catch (error) {
    recordCompletedDispatch(null, null, "error")
    const schemaResp = daemonDispatchSchemaFailureResponse(error)
    if (schemaResp) return schemaResp
    throw error
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
