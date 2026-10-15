/** Session bookkeeping and advice policy for daemon dispatch, independent of HTTP. */
import { hasDeadlineContext } from "../../dispatch/deadline-context.ts"
import { isBlock } from "../../dispatch/engine.ts"
import type { DispatchLifecycleUpdate } from "../../dispatch/execute.ts"
import { isSubagentUsageKey, sessionUsageKey } from "../../dispatch/session-usage-key.ts"
import {
  DEFAULT_STOP_DISPATCH_ALLOW_CONTEXT,
  isStopLikeDispatchEvent,
} from "../../dispatch/stop-response.ts"
import { mcpCallerCwdRegistry } from "../../mcp-caller-cwd.ts"
import { taskCompletedHookInputSchema, taskCreatedHookInputSchema } from "../../schemas.ts"
import { isAnyProviderTaskCreateTool, isAnyProviderTaskUpdateTool } from "../../tool-matchers.ts"
import type { CurrentSessionToolUsage } from "../../transcript-summary.ts"
import {
  CONCURRENT_WORK_BOUNDARY,
  CONCURRENT_WORK_REASSURANCE,
} from "../../utils/concurrent-work-guidance.ts"
import type { CappedMap } from "./cache/capped-map.ts"
import type { DispatchRequestScope } from "./dispatch-request-scope.ts"
import {
  classifyDivergenceWeight,
  divergenceEvidence,
  recordDivergenceToolCall,
  recoverSessionDivergence,
  type SessionDivergenceState,
  taskMutationOutcome,
} from "./divergence.ts"
import {
  ACTIVE_LIFECYCLE_TASKS_PAYLOAD_KEY,
  formatLifecycleTaskAdvisory,
  type LifecycleTaskPayload,
  type LifecycleTaskRegistry,
} from "./lifecycle-task-registry.ts"
import { registerProjectAndTouch } from "./route-helpers.ts"
import type { DaemonMetrics, LastUserMessageCache, TranscriptIndexCache } from "./runtime-cache.ts"
import { sessionToolCallPersistenceQueue } from "./session-tool-call-persistence.ts"
import type { ActiveHookDispatch } from "./types.ts"
import {
  type CapturedToolCall,
  captureSessionToolCall,
  captureSessionToolUsage,
  readPersistedSessionToolCalls,
  type SessionToolUsageState,
  seedSessionToolUsage,
} from "./utils.ts"
import type { DaemonWorkerRuntime } from "./worker-runtime.ts"

export interface DispatchSessionContext {
  getProjectMetrics: (cwd: string) => DaemonMetrics
  sessionActivity: Map<string, { lastSeen: number; dispatches: number }>
  sessionToolCalls: Map<string, CapturedToolCall[]>
  sessionToolUsage: Map<string, SessionToolUsageState>
  sessionDivergence: Map<string, SessionDivergenceState>
  activeHookDispatches: Map<string, ActiveHookDispatch>
  workerRuntime: DaemonWorkerRuntime
  touchProject: (cwd: string) => void
  registerProjectWatchers: (cwd: string) => void
  transcriptIndex: TranscriptIndexCache
  lastUserMessageCache: LastUserMessageCache
  lifecycleTaskRegistry: LifecycleTaskRegistry
  recentHookAllowMessages: CappedMap<string, string>
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
    // A bare allow tells Claude Code to skip the permission prompt (#963); keep an allow only
    // when it carries rewritten input, which needs the decision to apply.
    const rewritesInput = output.updatedInput !== undefined || output.modifiedInput !== undefined
    if (output.permissionDecision === "allow" && !rewritesInput) delete output.permissionDecision
    if (Object.keys(output).every((key) => key === "hookEventName")) {
      delete response.hookSpecificOutput
    }
  }
}

/** Strip only known standing advice; changing file lists and specific remedies stay intact. */
function suppressStandingAdvice(
  cache: Map<string, string>,
  scope: string,
  response: Record<string, any>
): void {
  const fields = [
    [response, "systemMessage"],
    [response.hookSpecificOutput, "additionalContext"],
  ] as const
  for (const guidance of [CONCURRENT_WORK_REASSURANCE, CONCURRENT_WORK_BOUNDARY]) {
    const key = `${scope}|guidance|${guidance}`
    const seen = cache.get(key) !== undefined
    let found = false
    for (const [output, field] of fields) {
      const text = output?.[field]
      if (typeof text !== "string" || !text.includes(guidance)) continue
      found = true
      if (!seen) continue
      const remaining = text
        .replaceAll(guidance, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
      if (remaining) output[field] = remaining
      else delete output[field]
    }
    if (found) cache.set(key, guidance)
  }
}

function mustPreserveHookMessage(canonicalEvent: string, response: Record<string, any>): boolean {
  const permission = response.hookSpecificOutput?.permissionDecision
  return (
    hasDeadlineContext(response) ||
    isStopLikeDispatchEvent(canonicalEvent) ||
    isBlock(response) ||
    permission === "deny" ||
    permission === "ask" ||
    Boolean(response.error) ||
    response.ok === false ||
    response.isError === true
  )
}

function hookGuidanceScope(payload: Record<string, unknown> | null): string | null {
  const sessionId = nonBlankString(payload?.session_id ?? payload?.sessionId)
  const cwd = nonBlankString(payload?.cwd)
  // Unknown identities must never share an advisory cache entry.
  return sessionId && cwd ? JSON.stringify([cwd, sessionId]) : null
}

function resetSessionGuidance(cache: Map<string, string>, scope: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${scope}|`)) cache.delete(key)
  }
}

export function maybeSuppressDuplicateAllowMessage(
  ctx: Pick<DispatchSessionContext, "recentHookAllowMessages">,
  payload: Record<string, unknown> | null,
  canonicalEvent: string,
  hookEventName: string,
  response: Record<string, any>
): void {
  if (mustPreserveHookMessage(canonicalEvent, response)) return
  const scope = hookGuidanceScope(payload)
  if (!scope) return
  if (canonicalEvent === "sessionStart" || canonicalEvent === "sessionEnd") {
    resetSessionGuidance(ctx.recentHookAllowMessages, scope)
  }

  const message = extractHookAllowMessage(response)
  if (message === null) return

  const key = `${scope}|message|${canonicalEvent}|${hookEventName}`
  const last = ctx.recentHookAllowMessages.get(key)
  if (last === message) {
    stripDuplicateAllowMessage(response)
    return
  }

  ctx.recentHookAllowMessages.set(key, message)
  suppressStandingAdvice(ctx.recentHookAllowMessages, scope, response)
}

export function createDispatchLifecycleHandler(
  ctx: DispatchSessionContext,
  signal: AbortSignal
): { onLifecycle: (update: DispatchLifecycleUpdate) => void; dispose: () => void } {
  const owned = new Set<string>()
  const clear = () => {
    for (const id of owned) ctx.activeHookDispatches.delete(id)
    owned.clear()
  }
  signal.addEventListener("abort", clear, { once: true })
  const onLifecycle = (update: DispatchLifecycleUpdate) => {
    if (update.phase === "start") {
      if (signal.aborted) return
      owned.add(update.requestId)
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
    owned.delete(update.requestId)
  }
  return {
    onLifecycle,
    dispose: () => {
      clear()
      signal.removeEventListener("abort", clear)
    },
  }
}

export async function updateParsedPayloadMetrics(
  ctx: DispatchSessionContext,
  payloadStr: string,
  canonicalEvent: string,
  scope: DispatchRequestScope
): Promise<DaemonMetrics | null> {
  const parsed = await ctx.workerRuntime.parseDispatchPayload(payloadStr, {
    signal: scope.signal,
    timeoutMs: scope.remainingMs(),
  })
  scope.signal.throwIfAborted()
  if (!parsed) return null

  const nowMs = Date.now()
  const projectMetrics = await metricsForParsedProject(ctx, parsed.cwd, scope.signal)
  if (!parsed.sessionId) return projectMetrics
  recordParsedSessionActivity(ctx, parsed.sessionId, canonicalEvent, nowMs)
  await captureParsedToolUse(ctx, parsed, canonicalEvent, nowMs, {
    payloadStr,
    signal: scope.signal,
  })
  return projectMetrics
}

async function metricsForParsedProject(
  ctx: DispatchSessionContext,
  cwd: string | null | undefined,
  signal: AbortSignal
): Promise<DaemonMetrics | null> {
  if (!cwd) return null
  const projectCwd = await registerProjectAndTouch(ctx, cwd, signal)
  return projectCwd ? ctx.getProjectMetrics(projectCwd) : null
}

function recordParsedSessionActivity(
  ctx: DispatchSessionContext,
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

async function captureParsedToolUse(
  ctx: DispatchSessionContext,
  parsed: ParsedDispatchPayload,
  canonicalEvent: string,
  nowMs: number,
  options: { payloadStr: string; signal: AbortSignal }
): Promise<void> {
  const { payloadStr, signal } = options
  const { sessionId, toolName } = parsed
  if (!sessionId || !toolName) return
  await hydrateDivergence(ctx, parsed.cwd, sessionId, signal)
  signal.throwIfAborted()
  const taskMutation =
    isAnyProviderTaskCreateTool(toolName) || isAnyProviderTaskUpdateTool(toolName)
  if (canonicalEvent === "postToolUse" && taskMutation) {
    captureTaskOutcome(ctx, { ...parsed, sessionId, toolName }, nowMs, payloadStr)
    return
  }
  if (canonicalEvent !== "preToolUse") return
  // A rootless `swiz mcp` forwards this call from cwd "/"; the hook carries the real cwd.
  mcpCallerCwdRegistry.record(toolName, parsed.toolInput, parsed.cwd, nowMs)
  const state = recordDivergenceToolCall(ctx.sessionDivergence, {
    sessionId,
    toolName,
    toolInput: parsed.toolInput,
    nowMs,
    movement: null,
    taskMutation: taskMutation ? "started" : undefined,
  })
  captureSessionToolCall(ctx.sessionToolCalls, sessionId, toolName, parsed.toolInput, nowMs)
  if (parsed.cwd) {
    sessionToolCallPersistenceQueue.enqueue({
      cwd: parsed.cwd,
      sessionId,
      toolName,
      toolInput: parsed.toolInput,
      nowMs,
      divergence: divergenceEvidence(
        state,
        "call",
        "unknown",
        classifyDivergenceWeight(toolName, parsed.toolInput)
      ),
    })
  }
  captureSessionToolUsage(
    ctx.sessionToolUsage,
    sessionUsageKey(sessionId, parsed.agentId),
    toolName,
    parsed.toolInput,
    nowMs
  )
}

async function hydrateDivergence(
  ctx: DispatchSessionContext,
  cwd: string | null | undefined,
  sessionId: string,
  signal: AbortSignal
): Promise<void> {
  if (!cwd || ctx.sessionDivergence.has(sessionId)) return
  const calls = await readPersistedSessionToolCalls(cwd, sessionId, undefined, undefined, true)
  signal.throwIfAborted()
  if (calls.length > 0 && !ctx.sessionDivergence.has(sessionId)) {
    ctx.sessionDivergence.set(sessionId, recoverSessionDivergence(calls, Date.now()))
  }
}

function captureTaskOutcome(
  ctx: DispatchSessionContext,
  parsed: ParsedDispatchPayload & { sessionId: string; toolName: string },
  nowMs: number,
  payloadStr: string
): void {
  const { sessionId, toolName } = parsed
  const payload = JSON.parse(payloadStr)
  const outcome = taskMutationOutcome(payload.tool_response ?? payload.toolResponse)
  const kind = isAnyProviderTaskCreateTool(toolName) ? "task-create" : "task-update"
  const state = recordDivergenceToolCall(ctx.sessionDivergence, {
    sessionId,
    toolName,
    nowMs,
    countCall: false,
    movement: outcome === "changed" ? kind : null,
    incomplete: outcome === "unknown",
    taskMutation: "resolved",
  })
  if (parsed.cwd)
    sessionToolCallPersistenceQueue.enqueue({
      cwd: parsed.cwd,
      sessionId,
      toolName,
      toolInput: undefined,
      nowMs,
      divergence: divergenceEvidence(state, "outcome", outcome, 0),
    })
}

export async function getCurrentSessionToolUsageFromDaemon(
  ctx: DispatchSessionContext,
  sessionId: string,
  transcriptPath?: string,
  signal?: AbortSignal
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

  // The parent transcript does not hold a subagent's calls; seeding from it would hand the
  // subagent the parent's streak (#962). An unseen subagent starts with an empty stream.
  if (isSubagentUsageKey(sessionId)) return { toolNames: [], skillInvocations: [], events: [] }
  if (!transcriptPath) return null
  const index = await ctx.transcriptIndex.get(transcriptPath)
  signal?.throwIfAborted()
  if (!index) return null
  const seeded = seedSessionToolUsage(ctx.sessionToolUsage, sessionId, index.summary, Date.now())
  return {
    toolNames: [...seeded.toolNames],
    skillInvocations: [...seeded.skillInvocations],
    events: seeded.events ? [...seeded.events] : undefined,
  }
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

export interface LifecycleTaskDispatchPreparation {
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
  ctx: DispatchSessionContext,
  canonicalEvent: string,
  payload: Record<string, unknown> | null,
  signal?: AbortSignal
): Promise<LifecycleTaskDispatchPreparation> {
  if (!payload) return { failOpen: true, payloadChanged: false }
  const lifecycle = lifecycleTaskPayload(canonicalEvent, payload)
  if (!lifecycle) return { failOpen: true, payloadChanged: false }
  const projectCwd = await registerProjectAndTouch(ctx, lifecycle.cwd, signal)
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
  ctx: DispatchSessionContext,
  canonicalEvent: string,
  payload: Record<string, unknown> | null,
  signal?: AbortSignal
): Promise<LifecycleTaskDispatchPreparation> {
  if (!payload) return { failOpen: false, payloadChanged: false }
  const sessionId = nonBlankString(payload.session_id)
  const cwd = nonBlankString(payload.cwd)
  if (!sessionId || !cwd) return { failOpen: false, payloadChanged: false }
  const projectCwd = await registerProjectAndTouch(ctx, cwd, signal)
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
  ctx: DispatchSessionContext,
  canonicalEvent: string,
  payload: Record<string, unknown> | null,
  signal?: AbortSignal
): Promise<LifecycleTaskDispatchPreparation> {
  return isTaskLifecycleEvent(canonicalEvent)
    ? prepareTaskLifecycleDispatch(ctx, canonicalEvent, payload, signal)
    : prepareSessionLifecycleDispatch(ctx, canonicalEvent, payload, signal)
}

export function mergeLifecycleStopAdvisory(
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
