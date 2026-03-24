/**
 * Shared dispatch execution — runs the full dispatch flow given a pre-read
 * payload string, returning the hook response object.
 *
 * Used by both the CLI `swiz dispatch` command and the daemon `/dispatch`
 * endpoint so that both paths execute identical logic.
 */

import { merge, orderBy } from "lodash-es"
import { isGitRepo } from "../git-helpers.ts"
import type { HookLogEntry } from "../hook-log.ts"
import { appendHookLogs } from "../hook-log.ts"
import { tryReplayPendingMutations } from "../issue-store.ts"
import type { HookGroup } from "../manifest.ts"
import { DISPATCH_TIMEOUTS, manifest } from "../manifest.ts"
import { loadAllPlugins } from "../plugins.ts"
import {
  getEffectiveSwizSettings,
  type ProjectSwizSettings,
  readProjectSettings,
  readSwizSettings,
  resolveProjectHooks,
} from "../settings.ts"
import { computeTranscriptSummary, type TranscriptSummary } from "../transcript-summary.ts"
import type { HookExecution } from "./engine.ts"
import {
  applyHookSettingFilters,
  countHooks,
  DISPATCH_ROUTES,
  groupMatches,
  log,
  logHeader,
  withLogBuffer,
} from "./index.ts"
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
  "prPoll",
])

export function parsePayload(payloadStr: string): {
  payload: Record<string, unknown>
  parseError: boolean
} {
  try {
    return {
      payload: JSON.parse(payloadStr || "{}") as Record<string, unknown>,
      parseError: false,
    }
  } catch {
    return { payload: {}, parseError: true }
  }
}

export function summarizeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) return ""
  const safeInput = input

  function getSubjectSummary(): string | undefined {
    if (typeof safeInput.subject === "string") {
      return safeInput.subject.length > 60
        ? `${safeInput.subject.slice(0, 57)}...`
        : safeInput.subject
    }
    return undefined
  }

  function getTaskSummary(): string | undefined {
    if (typeof safeInput.taskId === "string") {
      const parts = [`#${safeInput.taskId}`]
      if (typeof safeInput.status === "string") parts.push(safeInput.status)
      return parts.join(" -> ")
    }
    return undefined
  }

  function getSkillSummary(): string | undefined {
    if (typeof safeInput.skill === "string") {
      return typeof safeInput.args === "string"
        ? `${safeInput.skill} ${safeInput.args}`
        : safeInput.skill
    }
    return undefined
  }

  function getPathSummary(): string | undefined {
    const pathVal = (safeInput.path ??
      safeInput.file_path ??
      safeInput.file ??
      safeInput.filePath) as string | undefined
    if (typeof pathVal === "string") {
      return pathVal
    }
    return undefined
  }

  function getCommandSummary(): string | undefined {
    if (typeof safeInput.command === "string") {
      return safeInput.command.length > 80
        ? `${safeInput.command.slice(0, 77)}...`
        : safeInput.command
    }
    return undefined
  }

  function getPatternSummary(): string | undefined {
    if (typeof safeInput.pattern === "string") return safeInput.pattern
    return undefined
  }

  function getQuerySummary(): string | undefined {
    if (typeof safeInput.query === "string") {
      return safeInput.query.length > 60 ? `${safeInput.query.slice(0, 57)}...` : safeInput.query
    }
    return undefined
  }

  function getContentSummary(): string | undefined {
    if (typeof safeInput.content === "string") return `${safeInput.content.length} chars`
    return undefined
  }

  function getOldStringSummary(): string | undefined {
    if (typeof safeInput.old_string === "string") {
      return `replacing ${safeInput.old_string.split("\n").length} lines`
    }
    return undefined
  }

  return (
    getSubjectSummary() ??
    getTaskSummary() ??
    getSkillSummary() ??
    getPathSummary() ??
    getCommandSummary() ??
    getPatternSummary() ??
    getQuerySummary() ??
    getContentSummary() ??
    getOldStringSummary() ??
    ""
  )
}

function getHookContext(
  canonicalEvent: string,
  payload: Record<string, unknown>
): { toolName: string | undefined; trigger: string | undefined } {
  const toolName = (payload.tool_name ?? payload.toolName) as string | undefined
  const trigger =
    canonicalEvent === "sessionStart"
      ? ((payload.trigger ?? payload.hook_event_name) as string | undefined)
      : undefined
  return { toolName, trigger }
}

function backfillPayloadDefaults(payload: Record<string, unknown>): void {
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

async function loadCombinedManifest(cwd: string): Promise<CombinedManifestResult> {
  let combinedManifest: HookGroup[] = [...manifest]
  const projectSettings = await readProjectSettings(cwd)

  if (projectSettings?.plugins?.length) {
    const pluginResults = await loadAllPlugins(projectSettings.plugins, cwd)
    const pluginHooks = pluginResults.flatMap((r) => r.hooks)
    for (const result of pluginResults) {
      if (result.error) log(`   ⚠ plugin ${result.name}: ${result.error}`)
    }
    if (pluginHooks.length > 0) {
      combinedManifest = [...combinedManifest, ...pluginHooks]
      log(`   loaded ${pluginHooks.length} plugin hook group(s)`)
    }
  }

  if (projectSettings?.hooks?.length) {
    const { resolved, warnings } = resolveProjectHooks(projectSettings.hooks, cwd)
    for (const warning of warnings) log(`   ⚠ ${warning}`)
    if (resolved.length > 0) {
      combinedManifest = [...combinedManifest, ...resolved]
      log(`   loaded ${resolved.length} project-local hook group(s)`)
    }
  }

  return { manifest: combinedManifest, projectSettings }
}

async function enrichPayloadForHooks(
  payload: Record<string, unknown>,
  parseError: boolean,
  fallbackPayloadStr: string,
  summaryProvider?: (path: string) => Promise<TranscriptSummary | null>
): Promise<string> {
  if (parseError) return fallbackPayloadStr

  const transcriptPath = payload.transcript_path as string | undefined
  if (!transcriptPath) return fallbackPayloadStr

  const summary = summaryProvider
    ? await summaryProvider(transcriptPath)
    : await computeTranscriptSummary(transcriptPath)
  if (!summary) return fallbackPayloadStr

  const enriched = merge({}, payload, { _transcriptSummary: summary }) as Record<string, unknown>
  const enrichedPayloadStr = JSON.stringify(enriched)
  log(`   transcript summary: ${summary.toolCallCount} tools, ${summary.bashCommands.length} cmds`)
  return enrichedPayloadStr
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export interface DispatchRequest {
  canonicalEvent: string
  hookEventName: string
  payloadStr: string
  /** When true, async hooks are awaited with timeout instead of fire-and-forget. */
  daemonContext?: boolean
  /** Optional cached transcript summary provider (injected by daemon). */
  transcriptSummaryProvider?: (path: string) => Promise<TranscriptSummary | null>
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
  response: Record<string, unknown>
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
  payload: Record<string, unknown>,
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
  payload: Record<string, unknown>
  parseError: boolean
  payloadStr: string
  cwd: string
  toolName: string | undefined
  trigger: string | undefined
}

function buildDispatchContext(req: DispatchRequest): DispatchContext {
  const { canonicalEvent, hookEventName, payloadStr } = req
  const { payload, parseError } = parsePayload(payloadStr)
  backfillPayloadDefaults(payload)
  const { toolName, trigger } = getHookContext(canonicalEvent, payload)

  logHeader(canonicalEvent, hookEventName, toolName, trigger)
  log(`   payload: ${payloadStr.length} bytes${parseError ? " ⚠ INVALID JSON" : ""}`)
  logPayloadDiagnostics(payloadStr, payload, canonicalEvent)

  const cwd = (payload.cwd as string) ?? process.cwd()
  return { canonicalEvent, hookEventName, payload, parseError, payloadStr, cwd, toolName, trigger }
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
  const requestedHooks = filteredGroups.flatMap((group) => group.hooks.map((hook) => hook.file))
  const toolInput = (ctx.payload.tool_input ?? ctx.payload.toolInput) as
    | Record<string, unknown>
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

/** Set SWIZ_PROJECT_CWD env var and return previous value for restoration. */
function injectProjectCwd(cwd: string | undefined): string | undefined {
  const prev = process.env.SWIZ_PROJECT_CWD
  if (cwd) process.env.SWIZ_PROJECT_CWD = cwd
  return prev
}

/** Restore SWIZ_PROJECT_CWD to its previous value (issue #328). */
function restoreProjectCwd(prev: string | undefined): void {
  if (prev !== undefined) process.env.SWIZ_PROJECT_CWD = prev
  else delete process.env.SWIZ_PROJECT_CWD
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
  budgetMs: number,
  budgetSec: number | undefined,
  dispatchAbort: AbortController,
  canonicalEvent: string
): Promise<Record<string, unknown>> {
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

  try {
    const result = await Promise.race([
      strategy.execute(params),
      new Promise<typeof DISPATCH_TIMEOUT_SENTINEL>((resolve) =>
        setTimeout(() => resolve(DISPATCH_TIMEOUT_SENTINEL), budgetMs)
      ),
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

async function performDispatch(req: DispatchRequest): Promise<DispatchResult> {
  const t0 = performance.now()
  const ctx = buildDispatchContext(req)

  // Inject SWIZ_PROJECT_CWD so spawned hooks detect the correct package
  // manager without relying on process.cwd() (issue #328).
  const prevProjectCwd = injectProjectCwd(ctx.cwd)

  // Short-circuit: project capabilities require a git repo — skip dispatch for non-git dirs.
  if (!(await isGitRepo(ctx.cwd))) {
    log(`   ⏭ no .git in cwd, skipping dispatch`)
    restoreProjectCwd(prevProjectCwd)
    return { response: {} }
  }

  const tReplay = performance.now()
  await tryReplayPendingMutations(ctx.cwd)
  log(`   ⏱ replay: ${Math.round(performance.now() - tReplay)}ms`)

  const tManifest = performance.now()
  const { filteredGroups, projectSettings } = await resolveFilteredGroups(ctx, req.manifestProvider)
  log(`   ⏱ manifest+filter: ${Math.round(performance.now() - tManifest)}ms`)
  if (filteredGroups.length === 0) return { response: {} }

  // Compute effective settings once and inject into payload so hooks
  // don't need to independently read settings files (project > global > default).
  const globalSettings = await readSwizSettings()
  const sessionId = typeof ctx.payload.session_id === "string" ? ctx.payload.session_id : undefined
  const effectiveSettings = getEffectiveSwizSettings(globalSettings, sessionId, projectSettings)
  ctx.payload._effectiveSettings = effectiveSettings as unknown as Record<string, unknown>

  const lifecycleRequestId =
    (ctx.payload.request_id as string | undefined) ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const lifecycleStartedAt = Date.now()

  req.onDispatchLifecycle?.(
    buildLifecycleEvent("start", ctx, filteredGroups, lifecycleRequestId, lifecycleStartedAt)
  )

  const tEnrich = performance.now()
  const enrichedPayloadStr = await enrichPayloadForHooks(
    ctx.payload,
    ctx.parseError,
    JSON.stringify(ctx.payload),
    req.transcriptSummaryProvider
  )
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
      budgetMs,
      budgetSec,
      dispatchAbort,
      ctx.canonicalEvent
    )

    // Fire-and-forget log write — never blocks the dispatch response
    const executions = (response.hookExecutions ?? []) as HookExecution[]

    if (executions.length > 0) {
      const dispatchDurationMs = Math.round(performance.now() - dispatchStart)
      const logEntries = buildDispatchLogEntries(executions, ctx, dispatchDurationMs)
      void appendHookLogs(logEntries)
    }

    log(
      `   ⏱ total: ${Math.round(performance.now() - t0)}ms (hooks: ${Math.round(performance.now() - dispatchStart)}ms)`
    )
    return { response }
  } finally {
    restoreProjectCwd(prevProjectCwd)
    req.onDispatchLifecycle?.(
      buildLifecycleEvent("end", ctx, filteredGroups, lifecycleRequestId, lifecycleStartedAt)
    )
  }
}
