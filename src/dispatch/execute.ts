/**
 * Shared dispatch execution — runs the full dispatch flow given a pre-read
 * payload string, returning the hook response object.
 *
 * Used by both the CLI `swiz dispatch` command and the daemon `/dispatch`
 * endpoint so that both paths execute identical logic.
 */

import { randomUUID } from "node:crypto"
import { merge, orderBy, unset } from "lodash-es"
import { isGitRepo } from "../git-helpers.ts"
import type { HookLogEntry } from "../hook-log.ts"
import { appendHookLogs } from "../hook-log.ts"
import { tryReplayPendingMutations } from "../issue-store.ts"
import { DISPATCH_TIMEOUTS, type HookGroup, hookIdentifier, manifest } from "../manifest.ts"
import { loadAllPlugins } from "../plugins.ts"
import {
  getEffectiveSwizSettings,
  type ProjectSwizSettings,
  readProjectSettings,
  readProjectState,
  readSwizSettings,
  resolveProjectHooks,
} from "../settings.ts"
import {
  type CurrentSessionToolUsage,
  computeTranscriptSummary,
  type TranscriptSummary,
} from "../transcript-summary.ts"
import {
  assertDispatchInboundNotParseError,
  assertEnrichedDispatchPayloadRecord,
  assertNormalizedDispatchPayload,
  coerceDispatchAgentEnvelopeInPlace,
  parseDispatchPayloadString,
  parseValidatedAgentDispatchWireJson,
} from "./dispatch-zod-surfaces.ts"
import { type HookExecution, writeResponse } from "./engine.ts"
import {
  scheduleIncomingDispatchCapture,
  shouldCaptureIncomingPayloads,
} from "./incoming-capture.ts"
import {
  applyHookSettingFilters,
  countHooks,
  DISPATCH_ROUTES,
  groupMatches,
  log,
  logHeader,
  withLogBuffer,
} from "./index.ts"
import { normalizeAgentHookPayload } from "./payload-normalize.ts"
import { isStopLikeDispatchEvent, normalizeStopDispatchResponseInPlace } from "./stop-response.ts"
import { STRATEGY_REGISTRY } from "./strategies.ts"

// ─── Constants ────────────────────────────────────────────────────────────────

/** Grace period added to DISPATCH_TIMEOUTS before the hard dispatch-level cutoff (ms).
 *  This accounts for setup overhead (manifest loading, payload enrichment, etc.). */
const DISPATCH_TIMEOUT_GRACE_MS = 5_000

/** Sentinel used to detect dispatch-level timeout via Promise.race. */
const DISPATCH_TIMEOUT_SENTINEL = Symbol("dispatch-timeout")

// ─── Helpers (shared with CLI command) ────────────────────────────────────────

const TOOL_NAME_OPTIONAL_EVENTS = new Set([
  "sessionStart",
  "subagentStart",
  "subagentStop",
  "userPromptSubmit",
  "stop",
  "preCommit",
  "commitMsg",
  "prePush",
  "prPoll",
  "notification",
])

export function parsePayload(payloadStr: string): {
  payload: Record<string, any>
  parseError: boolean
} {
  return parseDispatchPayloadString(payloadStr)
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s
}

const TOOL_INPUT_EXTRACTORS: Array<(i: Record<string, any>) => string | undefined> = [
  (i) => (typeof i.subject === "string" ? truncate(i.subject, 60) : undefined),
  (i) => {
    if (typeof i.taskId !== "string") return undefined
    const parts = [`#${i.taskId}`]
    if (typeof i.status === "string") parts.push(i.status)
    return parts.join(" -> ")
  },
  (i) =>
    typeof i.skill === "string"
      ? typeof i.args === "string"
        ? `${i.skill} ${i.args}`
        : i.skill
      : undefined,
  (i) => {
    const v = (i.path ?? i.file_path ?? i.file ?? i.filePath) as string | undefined
    return typeof v === "string" ? v : undefined
  },
  (i) => (typeof i.command === "string" ? truncate(i.command, 80) : undefined),
  (i) => (typeof i.pattern === "string" ? i.pattern : undefined),
  (i) => (typeof i.query === "string" ? truncate(i.query, 60) : undefined),
  (i) => (typeof i.content === "string" ? `${i.content.length} chars` : undefined),
  (i) =>
    typeof i.old_string === "string"
      ? `replacing ${i.old_string.split("\n").length} lines`
      : undefined,
]

export function summarizeToolInput(input: Record<string, any> | undefined): string {
  if (!input) return ""
  for (const extract of TOOL_INPUT_EXTRACTORS) {
    const result = extract(input)
    if (result !== undefined) return result
  }
  return ""
}

export function getHookContext(
  canonicalEvent: string,
  payload: Record<string, any>
): { toolName: string | undefined; trigger: string | undefined } {
  const toolName = (payload.tool_name ?? payload.toolName) as string | undefined
  const trigger =
    canonicalEvent === "sessionStart"
      ? ((payload.trigger ?? payload.hook_event_name) as string | undefined)
      : undefined
  return { toolName, trigger }
}

function backfillPayloadDefaults(payload: Record<string, any>): void {
  if (!payload.cwd) {
    payload.cwd =
      process.env.GEMINI_CWD ||
      process.env.GEMINI_PROJECT_DIR ||
      process.env.CLAUDE_PROJECT_DIR ||
      process.cwd()
  }
  if (!payload.session_id) {
    payload.session_id = process.env.GEMINI_SESSION_ID || "unknown-session"
  }
}

interface CombinedManifestResult {
  manifest: HookGroup[]
  projectSettings: ProjectSwizSettings | null
}

async function loadPluginHooks(settings: ProjectSwizSettings, cwd: string): Promise<HookGroup[]> {
  if (!settings.plugins?.length) return []
  const pluginResults = await loadAllPlugins(settings.plugins, cwd)
  for (const result of pluginResults) {
    if (result.error) log(`   ⚠ plugin ${result.name}: ${result.error}`)
  }
  const pluginHooks = pluginResults.flatMap((r) => r.hooks)
  if (pluginHooks.length > 0) log(`   loaded ${pluginHooks.length} plugin hook group(s)`)
  return pluginHooks
}

function loadProjectHooks(settings: ProjectSwizSettings, cwd: string): HookGroup[] {
  if (!settings.hooks?.length) return []
  const { resolved, warnings } = resolveProjectHooks(settings.hooks, cwd)
  for (const warning of warnings) log(`   ⚠ ${warning}`)
  if (resolved.length > 0) log(`   loaded ${resolved.length} project-local hook group(s)`)
  return resolved
}

async function loadCombinedManifest(cwd: string): Promise<CombinedManifestResult> {
  const projectSettings = await readProjectSettings(cwd)
  if (!projectSettings) return { manifest: [...manifest], projectSettings }

  const pluginHooks = await loadPluginHooks(projectSettings, cwd)
  const projectHooks = loadProjectHooks(projectSettings, cwd)
  return {
    manifest: [...manifest, ...pluginHooks, ...projectHooks],
    projectSettings,
  }
}

interface EnrichPayloadOptions {
  payload: Record<string, any>
  summaryProvider?: (path: string) => Promise<TranscriptSummary | null>
  currentSessionToolUsageProvider?: (
    sessionId: string,
    transcriptPath?: string
  ) => Promise<CurrentSessionToolUsage | null>
  disableTranscriptSummaryFallback?: boolean
}

async function enrichPayloadForHooks(opts: EnrichPayloadOptions): Promise<string> {
  const {
    payload,
    summaryProvider,
    currentSessionToolUsageProvider,
    disableTranscriptSummaryFallback,
  } = opts

  let enriched = payload
  const transcriptPath = payload.transcript_path as string | undefined
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined

  if (currentSessionToolUsageProvider && sessionId) {
    const usage = await currentSessionToolUsageProvider(sessionId, transcriptPath)
    if (usage) {
      enriched = merge({}, enriched, { _currentSessionToolUsage: usage }) as Record<string, any>
      log(
        `   current-session usage: ${usage.toolNames.length} tools, ${usage.skillInvocations.length} skills`
      )
    }
  }

  const summary = await resolveTranscriptSummary(
    transcriptPath,
    summaryProvider,
    disableTranscriptSummaryFallback
  )
  if (summary) {
    enriched = merge({}, enriched, { _transcriptSummary: summary }) as Record<string, any>
    log(`   transcript: ${summary.toolCallCount} tools, ${summary.bashCommands.length} cmds`)
  }

  return JSON.stringify(assertEnrichedDispatchPayloadRecord(enriched))
}

async function resolveTranscriptSummary(
  transcriptPath: string | undefined,
  summaryProvider: EnrichPayloadOptions["summaryProvider"],
  disableFallback: boolean | undefined
): Promise<TranscriptSummary | null> {
  if (!transcriptPath) return null
  if (summaryProvider) return summaryProvider(transcriptPath)
  if (disableFallback) return null
  return computeTranscriptSummary(transcriptPath)
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export interface DispatchRequest {
  canonicalEvent: string
  hookEventName: string
  payloadStr: string
  /**
   * When true, fire-and-forget async file hooks use the worker pool and are awaited;
   * fire-and-forget inline hooks are also awaited. Does not change
   * `asyncMode: "block-until-complete"` hooks (they always run in the sync pipeline).
   */
  daemonContext?: boolean
  /** Optional cached transcript summary provider (injected by daemon). */
  transcriptSummaryProvider?: (path: string) => Promise<TranscriptSummary | null>
  /** Optional daemon-backed provider for current-session tool/skill usage. */
  currentSessionToolUsageProvider?: (
    sessionId: string,
    transcriptPath?: string
  ) => Promise<CurrentSessionToolUsage | null>
  /** When true, skip the default file-backed transcript summary enrichment. */
  disableTranscriptSummaryFallback?: boolean
  /** Optional cached manifest provider (injected by daemon to skip cold manifest rebuild). */
  manifestProvider?: (cwd: string) => Promise<HookGroup[]>
  /** Optional lifecycle callback for in-flight dispatch tracking. */
  onDispatchLifecycle?: (update: DispatchLifecycleUpdate) => void
  /** Optional abort signal from the caller (e.g. daemon request timeout).
   *  When fired, all running hook processes are SIGTERM'd and the dispatch
   *  returns early with a timeout error. */
  signal?: AbortSignal
}

export interface DispatchResult {
  response: Record<string, any>
}

export interface DispatchLifecycleUpdate {
  phase: "start" | "end"
  requestId: string
  canonicalEvent: string
  hookEventName: string
  cwd: string
  sessionId: string | null
  hooks: string[]
  startedAt: number
  toolName?: string
  toolInputSummary?: string
}

function logPayloadDiagnostics(
  payloadStr: string,
  payload: Record<string, any>,
  canonicalEvent: string
): void {
  if (payloadStr.length === 0) {
    log(`   ⚠ EMPTY STDIN — no payload received from agent`)
    return
  }
  const keys = orderBy(Object.keys(payload), [(key) => key], ["asc"])
  log(`   keys: ${keys.join(", ")}`)
  if (!payload.session_id) log(`   ⚠ missing session_id`)
  if (!TOOL_NAME_OPTIONAL_EVENTS.has(canonicalEvent) && !payload.tool_name && !payload.toolName) {
    log(`   ⚠ missing tool_name`)
  }
}

/**
 * Execute the full dispatch flow for a single hook event.
 *
 * This is the shared core used by both `swiz dispatch` (CLI) and the daemon
 * `/dispatch` endpoint. It parses the payload, loads the manifest, matches
 * hook groups, and runs the appropriate strategy.
 *
 * Note: the engine strategy functions still write to process.stdout (for CLI
 * backward compatibility). When called from the daemon, stdout is not
 * connected to the agent — only the returned response matters.
 */
interface DispatchContext {
  canonicalEvent: string
  hookEventName: string
  payload: Record<string, any>
  payloadStr: string
  cwd: string
  toolName: string | undefined
  trigger: string | undefined
}

function buildDispatchContext(req: DispatchRequest): DispatchContext {
  const { canonicalEvent, hookEventName, payloadStr } = req
  const { payload, parseError } = parsePayload(payloadStr)
  assertDispatchInboundNotParseError(canonicalEvent, parseError)

  const captureIncoming = shouldCaptureIncomingPayloads()
  let incomingBeforeNormalize: Record<string, any> | null = null
  if (captureIncoming) {
    incomingBeforeNormalize = structuredClone(payload) as Record<string, any>
  }

  normalizeAgentHookPayload(payload)
  backfillPayloadDefaults(payload)
  const validated = assertNormalizedDispatchPayload(canonicalEvent, payload)
  for (const k of Object.keys(payload)) unset(payload, k)
  merge(payload, validated)
  const { toolName, trigger } = getHookContext(canonicalEvent, payload)

  logHeader(canonicalEvent, hookEventName, toolName, trigger)
  log(`   payload: ${payloadStr.length} bytes`)
  logPayloadDiagnostics(payloadStr, payload, canonicalEvent)

  const cwd = (payload.cwd as string) ?? process.cwd()

  if (captureIncoming) {
    scheduleIncomingDispatchCapture({
      canonicalEvent,
      hookEventName,
      parseError: false,
      payloadStr,
      incomingBeforeNormalize,
      normalizedPayload: structuredClone(payload) as Record<string, any>,
    })
  }

  return { canonicalEvent, hookEventName, payload, payloadStr, cwd, toolName, trigger }
}

interface ResolvedGroups {
  filteredGroups: HookGroup[]
  projectSettings: ProjectSwizSettings | null | undefined
}

async function resolveFilteredGroups(
  ctx: DispatchContext,
  manifestProvider?: DispatchRequest["manifestProvider"]
): Promise<ResolvedGroups> {
  let combinedManifest: HookGroup[]
  let preloadedProjectSettings: ProjectSwizSettings | null | undefined

  if (manifestProvider) {
    combinedManifest = await manifestProvider(ctx.cwd)
    preloadedProjectSettings = undefined // daemon provides manifest but not settings snapshot
  } else {
    const result = await loadCombinedManifest(ctx.cwd)
    combinedManifest = result.manifest
    preloadedProjectSettings = result.projectSettings
  }

  const matchingGroups = combinedManifest.filter(
    (g) => g.event === ctx.canonicalEvent && groupMatches(g, ctx.toolName, ctx.trigger)
  )
  const filteredGroups = await applyHookSettingFilters(
    matchingGroups,
    ctx.payload,
    preloadedProjectSettings
  )

  log(
    `   matched ${matchingGroups.length} group(s) from ${combinedManifest.filter((g) => g.event === ctx.canonicalEvent).length} total`
  )
  const skippedHooks = countHooks(matchingGroups) - countHooks(filteredGroups)
  if (skippedHooks > 0) {
    log(`   skipped ${skippedHooks} PR-merge hook(s) (pr-merge-mode disabled)`)
  }
  return { filteredGroups, projectSettings: preloadedProjectSettings }
}

function buildLifecycleEvent(
  phase: "start" | "end",
  ctx: DispatchContext,
  filteredGroups: HookGroup[],
  requestId: string,
  startedAt: number
): Parameters<NonNullable<DispatchRequest["onDispatchLifecycle"]>>[0] {
  const requestedHooks = filteredGroups.flatMap((group) =>
    group.hooks.map((hook) => hookIdentifier(hook))
  )
  const toolInput = (ctx.payload.tool_input ?? ctx.payload.toolInput) as
    | Record<string, any>
    | undefined
  return {
    phase,
    requestId,
    canonicalEvent: ctx.canonicalEvent,
    hookEventName: ctx.hookEventName,
    cwd: ctx.cwd,
    sessionId: typeof ctx.payload.session_id === "string" ? ctx.payload.session_id : null,
    hooks: [...new Set(requestedHooks)],
    startedAt,
    toolName: ctx.toolName,
    toolInputSummary: toolInput ? summarizeToolInput(toolInput) : undefined,
  }
}

export function executeDispatch(req: DispatchRequest): Promise<DispatchResult> {
  return withLogBuffer(() => performDispatch(req))
}

/** Create an AbortController merged with an optional incoming abort signal. */
function buildDispatchAbortController(signal: AbortSignal | undefined): AbortController {
  const controller = new AbortController()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener("abort", () => controller.abort(), { once: true })
  return controller
}

/** Execute strategy with optional timeout budget and return response. */
async function executeStrategyWithTimeout(
  strategy: (typeof STRATEGY_REGISTRY)[keyof typeof STRATEGY_REGISTRY],
  params: Parameters<typeof strategy.execute>[0],
  budget: { ms: number; sec: number | undefined; abort: AbortController; event: string }
): Promise<Record<string, any>> {
  const { ms: budgetMs, sec: budgetSec, abort: dispatchAbort, event: canonicalEvent } = budget
  if (budgetMs <= 0) {
    return await strategy.execute(params)
  }

  const budgetTimer = setTimeout(() => {
    log(
      `   ⏱ DISPATCH TIMEOUT — ${canonicalEvent} exceeded budget ` +
        `(${budgetSec}s + ${DISPATCH_TIMEOUT_GRACE_MS / 1000}s grace) — aborting hooks`
    )
    dispatchAbort.abort()
  }, budgetMs)

  // Promise.race sentinel — clear in `finally` when strategy resolves first (orphaned timers otherwise).
  let sentinelTimer: ReturnType<typeof setTimeout> | undefined

  try {
    const result = await Promise.race([
      strategy.execute(params),
      new Promise<typeof DISPATCH_TIMEOUT_SENTINEL>((resolve) => {
        sentinelTimer = setTimeout(() => resolve(DISPATCH_TIMEOUT_SENTINEL), budgetMs)
      }),
    ])

    if (result === DISPATCH_TIMEOUT_SENTINEL) {
      if (!dispatchAbort.signal.aborted) dispatchAbort.abort()
      return {
        error: `dispatch timeout: ${canonicalEvent} exceeded ${budgetSec}s budget`,
      }
    }

    return result
  } finally {
    clearTimeout(budgetTimer)
    if (sentinelTimer) clearTimeout(sentinelTimer)
  }
}

/** Build hook log entries from executions and dispatch summary. */
function buildDispatchLogEntries(
  executions: HookExecution[],
  ctx: ReturnType<typeof buildDispatchContext>,
  dispatchDurationMs: number
): HookLogEntry[] {
  const sessionId = typeof ctx.payload.session_id === "string" ? ctx.payload.session_id : undefined

  const logEntries: HookLogEntry[] = executions.map((exec) => ({
    ts: new Date(exec.startTime).toISOString(),
    event: ctx.canonicalEvent,
    hookEventName: ctx.hookEventName,
    hook: exec.file,
    status: exec.status,
    skipReason: exec.skipReason,
    durationMs: exec.durationMs,
    exitCode: exec.exitCode,
    matcher: exec.matcher,
    sessionId,
    cwd: ctx.cwd,
    toolName: ctx.toolName,
    stdoutSnippet: exec.stdoutSnippet || undefined,
    stderrSnippet: exec.stderrSnippet || undefined,
  }))

  const ranCount = executions.filter((h) => h.status !== "skipped").length
  logEntries.push({
    ts: new Date().toISOString(),
    event: ctx.canonicalEvent,
    hookEventName: ctx.hookEventName,
    hook: "dispatch",
    status: ranCount === 0 ? "no-hooks" : "ok",
    durationMs: dispatchDurationMs,
    exitCode: null,
    kind: "dispatch",
    hookCount: ranCount,
    sessionId,
    cwd: ctx.cwd,
    toolName: ctx.toolName,
  })

  return logEntries
}

async function injectEffectiveSettings(
  ctx: ReturnType<typeof buildDispatchContext>,
  projectSettings: ProjectSwizSettings | null
): Promise<void> {
  const [globalSettings, projectState] = await Promise.all([
    readSwizSettings(),
    readProjectState(ctx.cwd),
  ])
  const sessionId = typeof ctx.payload.session_id === "string" ? ctx.payload.session_id : undefined
  const effectiveSettings = getEffectiveSwizSettings(globalSettings, sessionId, projectSettings)
  ctx.payload._effectiveSettings = effectiveSettings as unknown as Record<string, any>
  ctx.payload._projectState = projectState as unknown
}

async function prepareDispatchGroups(
  ctx: ReturnType<typeof buildDispatchContext>,
  manifestProvider?: (cwd: string) => Promise<HookGroup[]>
) {
  const tReplay = performance.now()
  await tryReplayPendingMutations(ctx.cwd)
  log(`   ⏱ replay: ${Math.round(performance.now() - tReplay)}ms`)

  const tManifest = performance.now()
  const result = await resolveFilteredGroups(ctx, manifestProvider)
  log(`   ⏱ manifest+filter: ${Math.round(performance.now() - tManifest)}ms`)
  return result
}

/** Fallback uses RFC 4122 UUID v4 when the agent omits `request_id`. */
export function resolveLifecycleRequestId(payload: Record<string, any>): string {
  const fromPayload = payload.request_id as string | undefined
  if (typeof fromPayload === "string" && fromPayload.length > 0) {
    return fromPayload
  }
  return randomUUID()
}

function assertDispatchResponseMatchesWire(
  response: Record<string, any>,
  canonicalEvent: string,
  hookEventName: string
): void {
  parseValidatedAgentDispatchWireJson(response, canonicalEvent, hookEventName)
}

async function performDispatch(req: DispatchRequest): Promise<DispatchResult> {
  const t0 = performance.now()
  const ctx = buildDispatchContext(req)

  // Short-circuit: project capabilities require a git repo — skip dispatch for non-git dirs.
  if (!(await isGitRepo(ctx.cwd))) {
    log(`   ⏭ no .git in cwd, skipping dispatch`)
    const response: Record<string, any> = {}
    if (isStopLikeDispatchEvent(ctx.canonicalEvent)) {
      normalizeStopDispatchResponseInPlace(response, ctx.hookEventName)
      coerceDispatchAgentEnvelopeInPlace(response, ctx.canonicalEvent, ctx.hookEventName)
      if (!req.daemonContext) writeResponse(response)
    }
    assertDispatchResponseMatchesWire(response, ctx.canonicalEvent, ctx.hookEventName)
    return { response }
  }

  const { filteredGroups, projectSettings } = await prepareDispatchGroups(ctx, req.manifestProvider)
  if (filteredGroups.length === 0) {
    const response: Record<string, any> = {}
    if (isStopLikeDispatchEvent(ctx.canonicalEvent)) {
      normalizeStopDispatchResponseInPlace(response, ctx.hookEventName)
      coerceDispatchAgentEnvelopeInPlace(response, ctx.canonicalEvent, ctx.hookEventName)
      if (!req.daemonContext) writeResponse(response)
    }
    assertDispatchResponseMatchesWire(response, ctx.canonicalEvent, ctx.hookEventName)
    return { response }
  }

  await injectEffectiveSettings(ctx, projectSettings ?? null)

  const lifecycleRequestId = resolveLifecycleRequestId(ctx.payload)
  const lifecycleStartedAt = Date.now()

  req.onDispatchLifecycle?.(
    buildLifecycleEvent("start", ctx, filteredGroups, lifecycleRequestId, lifecycleStartedAt)
  )

  const tEnrich = performance.now()
  const enrichedPayloadStr = await enrichPayloadForHooks({
    payload: ctx.payload,
    summaryProvider: req.transcriptSummaryProvider,
    currentSessionToolUsageProvider: req.currentSessionToolUsageProvider,
    disableTranscriptSummaryFallback: req.disableTranscriptSummaryFallback,
  })
  log(`   ⏱ enrich: ${Math.round(performance.now() - tEnrich)}ms`)

  const strategyName = DISPATCH_ROUTES[ctx.canonicalEvent] ?? "blocking"
  const strategy = STRATEGY_REGISTRY[strategyName]

  // Enforce dispatch-level timeout budget from DISPATCH_TIMEOUTS.
  // Individual hooks already have per-hook timeouts; this is a safety net
  // for the aggregate (queuing delays, concurrent fan-out overhead, etc.).
  const budgetSec = DISPATCH_TIMEOUTS[ctx.canonicalEvent]
  const budgetMs = budgetSec ? budgetSec * 1000 + DISPATCH_TIMEOUT_GRACE_MS : 0

  // Merge caller-provided abort signal (from daemon request timeout) with
  // our own dispatch-level timeout into a single controller.
  const dispatchAbort = buildDispatchAbortController(req.signal)

  const dispatchStart = performance.now()
  try {
    const response = await executeStrategyWithTimeout(
      strategy,
      {
        filteredGroups,
        enrichedPayloadStr,
        canonicalEvent: ctx.canonicalEvent,
        hookEventName: ctx.hookEventName,
        daemonContext: req.daemonContext,
        cwd: ctx.cwd,
        signal: dispatchAbort.signal,
      },
      { ms: budgetMs, sec: budgetSec, abort: dispatchAbort, event: ctx.canonicalEvent }
    )

    // Fire-and-forget log write — never blocks the dispatch response
    const executions = (response.hookExecutions ?? []) as HookExecution[]

    if (executions.length > 0) {
      const dispatchDurationMs = Math.round(performance.now() - dispatchStart)
      const logEntries = buildDispatchLogEntries(executions, ctx, dispatchDurationMs)
      void appendHookLogs(logEntries)
    }

    if (!(typeof response.error === "string" && response.error.length > 0)) {
      if (isStopLikeDispatchEvent(ctx.canonicalEvent)) {
        normalizeStopDispatchResponseInPlace(response, ctx.hookEventName)
      }
      coerceDispatchAgentEnvelopeInPlace(response, ctx.canonicalEvent, ctx.hookEventName)
    }

    assertDispatchResponseMatchesWire(response, ctx.canonicalEvent, ctx.hookEventName)

    log(
      `   ⏱ total: ${Math.round(performance.now() - t0)}ms (hooks: ${Math.round(performance.now() - dispatchStart)}ms)`
    )
    return { response }
  } finally {
    req.onDispatchLifecycle?.(
      buildLifecycleEvent("end", ctx, filteredGroups, lifecycleRequestId, lifecycleStartedAt)
    )
  }
}
