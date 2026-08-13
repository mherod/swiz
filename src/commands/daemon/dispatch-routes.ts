/**
 * Dispatch route handlers for the daemon web server.
 * Extracted from web-server.ts (issue #685) to keep routing code focused.
 */
import { join } from "node:path"
import { ZodError } from "zod"
import { debugLog } from "../../debug.ts"
import { ensureDispatchId } from "../../dispatch/dispatch-id.ts"
import {
  DispatchPayloadValidationError,
  parseValidatedAgentDispatchWireJson,
} from "../../dispatch/dispatch-zod-surfaces.ts"
import { isBlock } from "../../dispatch/engine.ts"
import {
  type DispatchLifecycleUpdate,
  type DispatchResult,
  executeDispatch,
} from "../../dispatch/execute.ts"
import {
  scheduleIncomingDispatchCapture,
  schedulePayloadJsonlAppend,
  scheduleStaleIncomingCapturePrune,
  shouldCaptureIncomingPayloads,
} from "../../dispatch/incoming-capture.ts"
import { DISPATCH_ROUTES } from "../../dispatch/index.ts"
import {
  DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT,
  isStopLikeDispatchEvent,
} from "../../dispatch/stop-response.ts"
import type { DispatchStageDurations } from "../../dispatch/timing.ts"
import { DISPATCH_TIMEOUTS } from "../../manifest.ts"
import { taskCompletedHookInputSchema, taskCreatedHookInputSchema } from "../../schemas.ts"
import { createTaskStoreForHookPayload } from "../../task-roots.ts"
import type { CurrentSessionToolUsage } from "../../transcript-summary.ts"
import type { WarmStatusLineSnapshot } from "../status-line.ts"
import type { CappedMap } from "./cache/capped-map.ts"
import {
  ACTIVE_LIFECYCLE_TASKS_PAYLOAD_KEY,
  formatLifecycleTaskAdvisory,
  type LifecycleTaskPayload,
  type LifecycleTaskRegistry,
} from "./lifecycle-task-registry.ts"
import { registerProjectAndTouch } from "./route-helpers.ts"
import {
  type DaemonMetrics,
  type DispatchOutcome,
  type LastUserMessageCache,
  type ManifestCache,
  type RepositoryCapabilityCache,
  recordDispatch,
  type TranscriptIndexCache,
} from "./runtime-cache.ts"
import { sessionToolCallPersistenceQueue } from "./session-tool-call-persistence.ts"
import type { ActiveHookDispatch } from "./types.ts"
import type { UpstreamSyncRegistry } from "./upstream-sync.ts"
import type { CapturedToolCall, SessionToolUsageState } from "./utils.ts"
import { captureSessionToolCall, captureSessionToolUsage, seedSessionToolUsage } from "./utils.ts"
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
  repositoryCapabilityCache: RepositoryCapabilityCache
  resolveSnapshot: (
    cwd: string,
    sessionId: string | null | undefined
  ) => Promise<WarmStatusLineSnapshot>
  upstreamSyncRegistry: UpstreamSyncRegistry
  transcriptIndex: TranscriptIndexCache
  lastUserMessageCache: LastUserMessageCache
  taskStateCache: import("../../tasks/task-state-cache.ts").TaskStateCache
  lifecycleTaskRegistry: LifecycleTaskRegistry
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
    repositoryCapabilityCache: ctx.repositoryCapabilityCache,
    resolveSnapshot: ctx.resolveSnapshot,
    upstreamSyncRegistry: ctx.upstreamSyncRegistry,
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

function trimHookText(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function extractHookAllowMessage(response: Record<string, any>): string | null {
  const output = objectRecord(response.hookSpecificOutput)
  const message = {
    additionalContext: trimHookText(output?.additionalContext),
    systemMessage: trimHookText(response.systemMessage),
    reason: trimHookText(response.reason),
    stopReason: trimHookText(response.stopReason),
    permissionDecisionReason: trimHookText(output?.permissionDecisionReason),
  }
  return Object.values(message).every((value) => value === null) ? null : JSON.stringify(message)
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
  canonicalEvent: string
): Promise<DaemonMetrics | null> {
  const parsed = await ctx.workerRuntime.parseDispatchPayload(payloadStr)
  if (!parsed) return null

  const nowMs = Date.now()
  const projectMetrics = await metricsForParsedProject(ctx, parsed.cwd)
  if (!parsed.sessionId) return projectMetrics
  recordParsedSessionActivity(ctx, parsed.sessionId, canonicalEvent, nowMs)
  captureParsedToolUse(ctx, parsed, canonicalEvent, nowMs)
  return projectMetrics
}

async function metricsForParsedProject(
  ctx: DispatchRoutesContext,
  cwd: string | null | undefined
): Promise<DaemonMetrics | null> {
  if (!cwd) return null
  const projectCwd = await registerProjectAndTouch(ctx, cwd)
  return projectCwd ? ctx.getProjectMetrics(projectCwd) : null
}

function recordParsedSessionActivity(
  ctx: DispatchRoutesContext,
  sessionId: string,
  canonicalEvent: string,
  nowMs: number
): void {
  const previous = ctx.sessionActivity.get(sessionId)
  ctx.sessionActivity.set(sessionId, {
    lastSeen: nowMs,
    dispatches: (previous?.dispatches ?? 0) + 1,
  })
  if (canonicalEvent === "userPromptSubmit") {
    ctx.lastUserMessageCache.recordFromHook(sessionId, nowMs)
  }
}

type ParsedDispatchPayload = NonNullable<
  Awaited<ReturnType<DaemonWorkerRuntime["parseDispatchPayload"]>>
>

function captureParsedToolUse(
  ctx: DispatchRoutesContext,
  parsed: ParsedDispatchPayload,
  canonicalEvent: string,
  nowMs: number
): void {
  if (canonicalEvent !== "preToolUse" || !parsed.sessionId || !parsed.toolName) return
  captureSessionToolCall(
    ctx.sessionToolCalls,
    parsed.sessionId,
    parsed.toolName,
    parsed.toolInput,
    nowMs
  )
  if (parsed.cwd) {
    sessionToolCallPersistenceQueue.enqueue({
      cwd: parsed.cwd,
      sessionId: parsed.sessionId,
      toolName: parsed.toolName,
      toolInput: parsed.toolInput,
      nowMs,
    })
  }
  captureSessionToolUsage(
    ctx.sessionToolUsage,
    parsed.sessionId,
    parsed.toolName,
    parsed.toolInput,
    nowMs
  )
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

interface LifecycleTaskFields {
  hook_event_name?: unknown
  session_id?: unknown
  cwd?: unknown
  task_id?: unknown
  task_subject?: unknown
  task_description?: unknown
  teammate_name?: unknown
  team_name?: unknown
}

interface ParsedLifecycleTaskDispatch {
  sessionId: string
  cwd: string
  task: LifecycleTaskPayload
}

interface LifecycleTaskDispatchPreparation {
  failOpen: boolean
  payloadChanged: boolean
  advisory?: string
}

function nonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function lifecycleTaskFromFields(
  fields: LifecycleTaskFields,
  expectedEvent: "TaskCreated" | "TaskCompleted"
): ParsedLifecycleTaskDispatch | null {
  if (fields.hook_event_name !== expectedEvent) return null
  const sessionId = nonBlankString(fields.session_id)
  if (!sessionId) return null
  const cwd = nonBlankString(fields.cwd)
  if (!cwd) return null
  const taskId = nonBlankString(fields.task_id)
  if (!taskId) return null
  const subject = nonBlankString(fields.task_subject)
  if (!subject) return null

  const task: LifecycleTaskPayload = { taskId, subject }
  if (typeof fields.task_description === "string") task.description = fields.task_description
  if (typeof fields.teammate_name === "string") task.teammateName = fields.teammate_name
  if (typeof fields.team_name === "string") task.teamName = fields.team_name
  return { sessionId, cwd, task }
}

function lifecycleTaskPayload(
  canonicalEvent: string,
  payload: Record<string, unknown>
): ParsedLifecycleTaskDispatch | null {
  if (canonicalEvent === "taskCreated") {
    const parsed = taskCreatedHookInputSchema.safeParse(payload)
    return parsed.success ? lifecycleTaskFromFields(parsed.data, "TaskCreated") : null
  }
  if (canonicalEvent === "taskCompleted") {
    const parsed = taskCompletedHookInputSchema.safeParse(payload)
    return parsed.success ? lifecycleTaskFromFields(parsed.data, "TaskCompleted") : null
  }
  return null
}

function isTaskLifecycleEvent(canonicalEvent: string): boolean {
  return canonicalEvent === "taskCreated" || canonicalEvent === "taskCompleted"
}

async function prepareTaskLifecycleDispatch(
  ctx: DispatchRoutesContext,
  canonicalEvent: string,
  payload: Record<string, unknown> | null
): Promise<LifecycleTaskDispatchPreparation> {
  if (!payload) return { failOpen: true, payloadChanged: false }
  const lifecycle = lifecycleTaskPayload(canonicalEvent, payload)
  if (!lifecycle) return { failOpen: true, payloadChanged: false }
  const projectCwd = await registerProjectAndTouch(ctx, lifecycle.cwd)
  if (!projectCwd) return { failOpen: true, payloadChanged: false }

  if (canonicalEvent === "taskCreated") {
    ctx.lifecycleTaskRegistry.recordCreated(projectCwd, lifecycle.sessionId, lifecycle.task)
  } else {
    ctx.lifecycleTaskRegistry.recordCompleted(
      projectCwd,
      lifecycle.sessionId,
      lifecycle.task.taskId
    )
  }
  return { failOpen: false, payloadChanged: false }
}

async function prepareSessionLifecycleDispatch(
  ctx: DispatchRoutesContext,
  canonicalEvent: string,
  payload: Record<string, unknown> | null
): Promise<LifecycleTaskDispatchPreparation> {
  if (!payload) return { failOpen: false, payloadChanged: false }
  const sessionId = nonBlankString(payload.session_id)
  const cwd = nonBlankString(payload.cwd)
  if (!sessionId || !cwd) return { failOpen: false, payloadChanged: false }
  const projectCwd = await registerProjectAndTouch(ctx, cwd)
  if (!projectCwd) return { failOpen: false, payloadChanged: false }

  if (canonicalEvent === "sessionEnd") {
    ctx.lifecycleTaskRegistry.clearProjectSession(projectCwd, sessionId)
    return { failOpen: false, payloadChanged: false }
  }
  if (canonicalEvent !== "stop") return { failOpen: false, payloadChanged: false }

  const activeTasks = ctx.lifecycleTaskRegistry.listActive(projectCwd, sessionId)
  if (activeTasks.length === 0) return { failOpen: false, payloadChanged: false }
  payload[ACTIVE_LIFECYCLE_TASKS_PAYLOAD_KEY] = activeTasks
  const advisory = formatLifecycleTaskAdvisory(activeTasks)
  return {
    failOpen: false,
    payloadChanged: true,
    ...(advisory ? { advisory } : {}),
  }
}

export async function prepareLifecycleTaskDispatch(
  ctx: DispatchRoutesContext,
  canonicalEvent: string,
  payload: Record<string, unknown> | null
): Promise<LifecycleTaskDispatchPreparation> {
  return isTaskLifecycleEvent(canonicalEvent)
    ? prepareTaskLifecycleDispatch(ctx, canonicalEvent, payload)
    : prepareSessionLifecycleDispatch(ctx, canonicalEvent, payload)
}

function mergeLifecycleStopAdvisory(
  response: Record<string, any>,
  advisory: string | undefined
): void {
  if (!advisory) return
  const existingSystemMessage =
    typeof response.systemMessage === "string" ? response.systemMessage.trim() : ""
  if (!existingSystemMessage.includes(advisory)) {
    response.systemMessage = existingSystemMessage
      ? `${existingSystemMessage}\n\n${advisory}`
      : advisory
  }
  if (response.reason === DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT) {
    response.reason = advisory
    response.stopReason = advisory
  }
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
  return (result, projectMetrics, outcome, persistenceMs) => {
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
  parsedPayload: Record<string, unknown>
): Promise<void> {
  try {
    const sessionId = typeof parsedPayload.session_id === "string" ? parsedPayload.session_id : null
    if (sessionId && ctx.taskStateCache) {
      const { tasksDir } = createTaskStoreForHookPayload(parsedPayload)
      const sessionTasksDir = join(tasksDir, sessionId)
      ctx.taskStateCache.watchSession(sessionId, sessionTasksDir)
      const { seedSessionFromDisk } = await import("../../tasks/task-event-state.ts")
      await seedSessionFromDisk(sessionId, sessionTasksDir)
    }
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
  ctx: DispatchRoutesContext
): Promise<PreparedDaemonDispatchPayload> {
  const payloadStr = await req.text()
  const { parsedPayload, dispatchIdAdded } = parseDaemonPayload(
    payloadStr,
    canonicalEvent,
    hookEventName
  )
  if (parsedPayload) await seedTaskStateAndCapturePayload(ctx, hookEventName, parsedPayload)

  const lifecyclePreparation = await prepareLifecycleTaskDispatch(
    ctx,
    canonicalEvent,
    parsedPayload
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

const DISPATCH_TIMEOUT_SENTINEL = Symbol("dispatch-timeout")

async function executeDaemonDispatch(options: {
  canonicalEvent: string
  ctx: DispatchRoutesContext
  dispatchPayloadStr: string
  hookEventName: string
  requestTimeoutMs: number
}): Promise<DispatchResult | typeof DISPATCH_TIMEOUT_SENTINEL> {
  const { canonicalEvent, ctx, dispatchPayloadStr, hookEventName, requestTimeoutMs } = options
  const requestAbort = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof DISPATCH_TIMEOUT_SENTINEL>((resolve) => {
    timeoutId = setTimeout(() => {
      requestAbort.abort()
      resolve(DISPATCH_TIMEOUT_SENTINEL)
    }, requestTimeoutMs)
  })
  try {
    return await Promise.race([
      executeDispatch({
        canonicalEvent,
        hookEventName,
        payloadStr: dispatchPayloadStr,
        daemonContext: true,
        signal: requestAbort.signal,
        transcriptSummaryProvider: (transcriptPath) =>
          ctx.transcriptIndex.getSummary(transcriptPath),
        currentSessionToolUsageProvider: async (sessionId, transcriptPath) =>
          getCurrentSessionToolUsageFromDaemon(ctx, sessionId, transcriptPath),
        lastUserMessageAtProvider: (sessionId) =>
          ctx.lastUserMessageCache.peek(sessionId)?.at ?? null,
        disableTranscriptSummaryFallback: true,
        manifestProvider: async (cwd) => ctx.manifestCache.get(cwd),
        repositoryCapabilityProvider: async (cwd) => ctx.repositoryCapabilityCache.get(cwd),
        onDispatchLifecycle: createDispatchLifecycleHandler(ctx),
      }),
      timeout,
    ])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
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
  lifecyclePreparation: LifecycleTaskDispatchPreparation
  parsedPayload: Record<string, unknown> | null
  raceResult: DispatchResult
  recordCompletedDispatch: ReturnType<typeof createDispatchMetricRecorder>
  dispatchPayloadStr: string
}): Promise<Response> {
  const {
    canonicalEvent,
    ctx,
    dispatchPayloadStr,
    hookEventName,
    lifecyclePreparation,
    parsedPayload,
    raceResult,
    recordCompletedDispatch,
  } = options
  const persistenceStartedAt = performance.now()
  const projectMetrics = await updateParsedPayloadMetrics(ctx, dispatchPayloadStr, canonicalEvent)

  try {
    const response = parseValidatedAgentDispatchWireJson(
      raceResult.response,
      canonicalEvent,
      hookEventName
    )
    mergeLifecycleStopAdvisory(response, lifecyclePreparation.advisory)
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
  const { dispatchPayloadStr, parsedPayload, lifecyclePreparation } =
    await prepareDaemonDispatchPayload(req, hookEventName, canonicalEvent, ctx)
  const recordCompletedDispatch = createDispatchMetricRecorder({
    ctx,
    canonicalEvent,
    fallbackRoute,
    requestStartedAt,
    captureMs: performance.now() - requestStartedAt,
    cliBootstrapMs: clientBootstrapDurationMs(parsedPayload),
  })

  if (lifecyclePreparation.failOpen) {
    const response = Response.json({})
    recordCompletedDispatch(null, null, "success")
    return response
  }
  const requestTimeoutMs = daemonDispatchRequestTimeoutMs(canonicalEvent)
  let raceResult: DispatchResult | typeof DISPATCH_TIMEOUT_SENTINEL
  try {
    raceResult = await executeDaemonDispatch({
      canonicalEvent,
      ctx,
      dispatchPayloadStr,
      hookEventName,
      requestTimeoutMs,
    })
  } catch (error) {
    const schemaResp = daemonDispatchSchemaFailureResponse(error)
    recordCompletedDispatch(null, null, "error")
    if (schemaResp) return schemaResp
    throw error
  }

  if (raceResult === DISPATCH_TIMEOUT_SENTINEL) {
    return dispatchTimeoutResponse(canonicalEvent, requestTimeoutMs, recordCompletedDispatch)
  }
  return completeDaemonDispatch({
    canonicalEvent,
    ctx,
    dispatchPayloadStr,
    hookEventName,
    lifecyclePreparation,
    parsedPayload,
    raceResult,
    recordCompletedDispatch,
  })
}

export function handleDispatchActive(url: URL, ctx: DispatchRoutesContext): Response {
  const cwd = url.searchParams.get("cwd")
  const sessionId = url.searchParams.get("sessionId")
  const active = [...ctx.activeHookDispatches.values()]
    .filter((entry) => (!cwd || entry.cwd === cwd) && (!sessionId || entry.sessionId === sessionId))
    .sort((a, b) => b.startedAt - a.startedAt)
  return Response.json({ active })
}
