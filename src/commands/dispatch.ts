/**
 * Dispatch command — CLI entry point for `swiz dispatch <event>`.
 *
 * The heavy lifting (filters, engine, replay) lives in src/dispatch/.
 * This file handles CLI parsing, plugin loading, transcript enrichment,
 * and re-exports all public symbols for backward compatibility.
 */

import { appendFile } from "node:fs/promises"
import {
  agentHasTaskListToolForHookPayload,
  shouldEnforceIncompleteTasksForHookPayload,
  taskToolNameForHookPayload,
} from "../agent-paths.ts"
import { debugLog, stderrLog } from "../debug.ts"
import {
  applyHookSettingFilters,
  assertDispatchInboundNotParseError,
  assertNormalizedDispatchPayload,
  backfillPayloadDefaults,
  coerceDispatchAgentEnvelopeInPlace,
  DISPATCH_ROUTES,
  didWriteDispatchResponse,
  formatTrace,
  getHookContext,
  groupMatches,
  log,
  markDispatchResponseWritten,
  normalizeAgentHookPayload,
  parsePayload,
  replayBlocking,
  replayContext,
  replayPreToolUse,
  resetDispatchResponseWriteState,
  shouldCaptureIncomingPayloads,
  withLogBuffer,
} from "../dispatch"
import { dispatchToolUseId, ensureDispatchId } from "../dispatch/dispatch-id.ts"
import { scheduleIncomingDispatchCapture } from "../dispatch/incoming-capture.ts"
import { normalizeStopDispatchResponseInPlace } from "../dispatch/stop-response.ts"
import { getHomeDirOrNull } from "../home.ts"
import { appendHookLog, type HookLogEntry } from "../hook-log.ts"
import { DISPATCH_TIMEOUTS, manifest } from "../manifest.ts"
import { swizDispatchLogPath } from "../temp-paths.ts"
import { isSkillMdOnlyFileEditPayload } from "../tool-matchers.ts"
import type { Command } from "../types.ts"
import { getEffectiveSwizSettingsForToolHook } from "../utils/hook-effective-settings.ts"
import { messageFromUnknownError } from "../utils/hook-json-helpers.ts"
import { sanitizeHookOutputForCurrentAgent } from "../utils/hook-output-agent-compat.ts"
import { checkIncompleteTasks } from "../utils/stop-incomplete-tasks-core.ts"
import { detectTerminal } from "../utils/terminal-detection.ts"
import { getDaemonPort } from "./daemon/daemon-admin.ts"

const DAEMON_PORT = getDaemonPort()
// Fallback for events not listed in DISPATCH_TIMEOUTS.
// Must be long enough for the daemon to complete unknown-event processing
// (daemon server-side fallback is 60s) but short enough for CLI responsiveness.
const DEFAULT_DAEMON_TIMEOUT_MS = 30_000

/**
 * Build a filtered environment for hook subprocesses.
 * Only includes essential variables needed for hook execution:
 * - PATH (command resolution)
 * - HOME (user-specific config)
 * - TERM, COLORTERM (terminal detection)
 * - SWIZ_* (internal configuration)
 * - ANTHROPIC_*, CURSOR_*, GEMINI_* (agent-specific auth/config)
 *
 * This reduces per-dispatch memory allocation by 50-80% compared to
 * cloning the entire process.env (~50-200KB per dispatch in LaunchAgent).
 */
function buildAllowlistedEnv(): Record<string, string> {
  const result: Record<string, string> = {}
  const allowlistPatterns = [
    /^PATH$/,
    /^HOME$/,
    /^(TERM|COLORTERM)$/,
    /^SWIZ_/,
    /^ANTHROPIC_/,
    /^CURSOR_/,
    /^CODEX_/,
    /^GEMINI_/,
    // Agent-identifying env vars — required so in-process hooks running inside
    // the daemon can resolve `detectCurrentAgent()` via payload._env instead of
    // the daemon's own process.env (which is launchd's environment).
    /^CLAUDECODE$/,
    /^CLAUDE_PROJECT_DIR$/,
  ]

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (allowlistPatterns.some((pattern) => pattern.test(key))) {
      result[key] = value
    }
  }

  return result
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Try to forward the dispatch request to the daemon.
 * Returns the parsed response on success, or null if the daemon is
 * unavailable, times out, or returns an invalid response.
 *
 * Skips a separate health check — the dispatch request itself serves as
 * the liveness probe. A separate /health round-trip adds ~350ms overhead
 * on every call when the daemon is unreachable.
 */
function daemonTimeoutForEvent(canonicalEvent: string): number {
  const budgetSec = DISPATCH_TIMEOUTS[canonicalEvent]
  if (budgetSec) return budgetSec * 1000
  return DEFAULT_DAEMON_TIMEOUT_MS
}

// ── Daemon failure backoff ────────────────────────────────────────────────
// After a transport failure (timeout, connection refused, non-200), skip the
// daemon for BACKOFF_MS to avoid burning the full timeout budget on every
// dispatch when the daemon is down. State is per-process — each CLI
// invocation starts fresh, which is fine because dispatch.ts exits after
// one dispatch cycle. The backoff matters for the daemon's own in-process
// re-dispatch (e.g. sessionStart triggering preToolUse internally).

const BACKOFF_MS = 30_000
let lastDaemonFailureAt = 0

function isDaemonBackedOff(): boolean {
  return lastDaemonFailureAt > 0 && Date.now() - lastDaemonFailureAt < BACKOFF_MS
}

function recordDaemonFailure(): void {
  lastDaemonFailureAt = Date.now()
}

/** Exported for testing — reset backoff state between test cases. */
export function resetDaemonBackoff(): void {
  lastDaemonFailureAt = 0
}

async function tryDaemonDispatch(
  canonicalEvent: string,
  hookEventName: string,
  payloadStr: string
): Promise<Record<string, any> | null> {
  if (process.env.SWIZ_NO_DAEMON === "1") {
    debugLog("daemon dispatch: skipped (SWIZ_NO_DAEMON=1)")
    return null
  }

  if (isDaemonBackedOff()) {
    debugLog("daemon dispatch: skipped (backoff active after recent failure)")
    return null
  }

  const url = `http://127.0.0.1:${DAEMON_PORT}/dispatch?event=${encodeURIComponent(canonicalEvent)}&hookEventName=${encodeURIComponent(hookEventName)}`

  try {
    const resp = await fetchWithTimeout(
      url,
      {
        method: "POST",
        body: payloadStr,
        headers: { "Content-Type": "application/json" },
      },
      daemonTimeoutForEvent(canonicalEvent)
    )

    if (!resp.ok) {
      recordDaemonFailure()
      debugLog(
        `daemon dispatch: failed (status ${resp.status}), falling back to local (backoff ${BACKOFF_MS}ms)`
      )
      return null
    }

    const raw: unknown = await resp.json()
    const json =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, any>)
        : {}
    debugLog(`daemon dispatch: forwarded ${canonicalEvent} to daemon (${resp.status})`)
    return json
  } catch (err) {
    recordDaemonFailure()
    const msg = messageFromUnknownError(err)
    debugLog(`daemon dispatch: error (${msg}), falling back to local (backoff ${BACKOFF_MS}ms)`)
    return null
  }
}

const STDIN_PAYLOAD_TIMEOUT_MS = 2_000

// HookContext replaced by getHookContext return type from hook-utils

async function readStdinPayloadWithTimeout(
  timeoutMs: number = STDIN_PAYLOAD_TIMEOUT_MS
): Promise<string> {
  const reader = Bun.stdin.stream().getReader()
  const decoder = new TextDecoder()
  let timedOut = false
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true
      // Cancel the active reader so Bun can terminate even if stdin remains open.
      void reader.cancel().catch(() => {})
      reject(
        new Error(`Timed out waiting ${timeoutMs / 1000}s for stdin JSON payload to be received`)
      )
    }, timeoutMs)
    timeoutHandle.unref?.()
  })

  const readAll = (async () => {
    let payload = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      payload += decoder.decode(value, { stream: true })
    }
    payload += decoder.decode()
    return payload
  })().catch((err) => {
    if (timedOut) return ""
    throw err
  })

  try {
    return await Promise.race([readAll, timeout])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    try {
      reader.releaseLock()
    } catch {}
  }
}

// ─── CLI timing log ─────────────────────────────────────────────────────────

interface CliTimingInfo {
  canonicalEvent: string
  hookEventName: string
  sessionId?: string
  cwd: string
  toolName?: string
  dispatchId?: string
  toolUseId?: string
  totalMs: number
  stdinMs: number
  daemonMs: number
  localMs?: number
  route: "daemon" | "local"
}

function appendCliTimingLog(info: CliTimingInfo): Promise<void> {
  const entry: HookLogEntry = {
    ts: new Date().toISOString(),
    event: info.canonicalEvent,
    hookEventName: info.hookEventName,
    hook: `cli:${info.route}`,
    status: "ok",
    durationMs: info.totalMs,
    exitCode: null,
    kind: "dispatch",
    sessionId: info.sessionId,
    cwd: info.cwd,
    toolName: info.toolName,
    dispatchId: info.dispatchId,
    toolUseId: info.toolUseId,
    stdoutSnippet: [
      `stdin: ${info.stdinMs}ms`,
      `daemon: ${info.daemonMs}ms (${info.route === "daemon" ? "forwarded" : "fallback"})`,
      info.localMs !== undefined ? `local: ${info.localMs}ms` : null,
      `total: ${info.totalMs}ms`,
    ]
      .filter(Boolean)
      .join(", "),
  }
  return appendHookLog(entry)
}

// ─── Fast path ─────────────────────────────────────────────────────────────

interface DispatchTiming {
  canonicalEvent: string
  hookEventName: string
  sessionId?: string
  cwd: string
  toolName?: string
  dispatchId?: string
  toolUseId?: string
  t0: number
  stdinMs: number
}

function isStopLikeEvent(canonicalEvent: string): boolean {
  return canonicalEvent === "stop" || canonicalEvent === "subagentStop"
}

/**
 * Claude only accepts `hookSpecificOutput` on these events. Emitting it elsewhere
 * (PreCompact, SessionStart, SessionEnd, Notification, SubagentStart, PreCommit, PrePush)
 * is rejected by the hook output schema as "Invalid input".
 */
function supportsHookSpecificOutput(canonicalEvent: string): boolean {
  return (
    canonicalEvent === "preToolUse" ||
    canonicalEvent === "postToolUse" ||
    canonicalEvent === "userPromptSubmit" ||
    canonicalEvent === "postToolBatch"
  )
}

function describeDispatchFailure(err: unknown): { message: string; detail: string } {
  if (err instanceof Error) {
    return {
      message: err.message,
      detail: err.stack ?? `${err.name}: ${err.message}`,
    }
  }

  const fallback = typeof err === "string" ? err : JSON.stringify(err, null, 2)
  return {
    message: fallback,
    detail: fallback,
  }
}

async function captureDispatchFailure(
  scope: string,
  canonicalEvent: string,
  hookEventName: string | undefined,
  err: unknown
): Promise<string> {
  const { detail } = describeDispatchFailure(err)
  const logPath = swizDispatchLogPath()
  const details = [
    "",
    `── ${new Date().toISOString()} ── dispatch failure ──`,
    `   scope: ${scope}`,
    `   event: ${canonicalEvent}`,
    `   hookEventName: ${hookEventName ?? "(none)"}`,
    `   pid: ${process.pid}`,
    `   cwd: ${process.cwd()}`,
    ...detail.split("\n").map((line) => `   ${line}`),
    "",
  ].join("\n")

  try {
    await appendFile(logPath, details)
  } catch {}
  return logPath
}

function buildDispatchFailureFallback(
  canonicalEvent: string,
  hookEventName: string,
  err: unknown,
  logPath: string
): Record<string, any> {
  const { message } = describeDispatchFailure(err)
  const systemMessage = `Dispatch runtime failure in ${canonicalEvent}. Allowed by fallback; details captured in ${logPath}.`
  if (isStopLikeEvent(canonicalEvent)) {
    return {
      continue: true,
      reason: message,
      stopReason: message,
      systemMessage,
    }
  }
  const detail = `Dispatch failed: ${message}. See ${logPath}.`
  if (supportsHookSpecificOutput(canonicalEvent)) {
    return {
      systemMessage,
      hookSpecificOutput: {
        hookEventName,
        additionalContext: detail,
      },
    }
  }
  // Events like PreCompact/SessionStart/Notification reject `hookSpecificOutput` —
  // collapse the detail into `systemMessage` so the envelope still validates.
  return {
    systemMessage: `${systemMessage} ${detail}`,
  }
}

function maybeForceDispatchFailureForTesting(): void {
  if (process.env.SWIZ_TEST_FORCE_DISPATCH_FAILURE === "1") {
    throw new Error("forced dispatch failure")
  }
}

/** In-process incomplete-tasks check — skips daemon round-trip when tasks block. */
async function tryStopFastPath(
  timing: DispatchTiming,
  payload: Record<string, unknown>
): Promise<boolean> {
  const { canonicalEvent, sessionId } = timing
  if (!isStopLikeEvent(canonicalEvent) || !sessionId) return false
  if (!shouldEnforceIncompleteTasksForHookPayload(payload)) return false

  const home = getHomeDirOrNull()
  if (!home) return false

  const tFast = performance.now()
  const blockResult = await checkIncompleteTasks(sessionId, home, {
    taskListAvailable: agentHasTaskListToolForHookPayload(payload),
    taskListToolName: taskToolNameForHookPayload(payload, "TaskList"),
    taskUpdateToolName: taskToolNameForHookPayload(payload, "TaskUpdate"),
  })
  log(`   ⏱ cli:fast-incomplete-tasks: ${Math.round(performance.now() - tFast)}ms`)

  if (!blockResult) return false

  process.stdout.write(`${JSON.stringify(blockResult)}\n`)
  markDispatchResponseWritten()
  const totalMs = Math.round(performance.now() - timing.t0)
  log(`   ⏱ cli:total: ${totalMs}ms (fast-path)`)
  void appendCliTimingLog({
    ...timing,
    totalMs,
    daemonMs: 0,
    route: "local",
  })
  return true
}

/**
 * Explicitly disabled auto-continue means a stop request is final. Resolve the
 * setting before the incomplete-task fast path so task and ship gates cannot
 * turn that stop into another work cycle.
 */
async function tryAutoContinueDisabledFastPath(
  timing: DispatchTiming,
  payload: Record<string, any>,
  hookEventName: string
): Promise<boolean> {
  if (!isStopLikeEvent(timing.canonicalEvent)) return false

  try {
    const effective = await getEffectiveSwizSettingsForToolHook({
      cwd: timing.cwd,
      session_id: timing.sessionId,
      payload,
    })
    if (effective.autoContinue !== false) return false
  } catch {
    return false
  }

  log(`   ⏭ autoContinue disabled, allowing explicit stop`)
  const response: Record<string, any> = {}
  normalizeStopDispatchResponseInPlace(response, hookEventName)
  coerceDispatchAgentEnvelopeInPlace(response, timing.canonicalEvent, hookEventName, payload._agent)
  process.stdout.write(`${JSON.stringify(response)}\n`)
  markDispatchResponseWritten()
  const totalMs = Math.round(performance.now() - timing.t0)
  void appendCliTimingLog({
    ...timing,
    totalMs,
    daemonMs: 0,
    route: "local",
  })
  return true
}

// ─── Dispatch callback ─────────────────────────────────────────────────────

function captureParsedPayload(
  canonicalEvent: string,
  hookEventName: string,
  payloadStr: string,
  payload: Record<string, any>,
  parseError: boolean
): void {
  if (!shouldCaptureIncomingPayloads()) return
  scheduleIncomingDispatchCapture({
    canonicalEvent,
    hookEventName,
    parseError,
    payloadStr,
    incomingBeforeNormalize: parseError ? null : structuredClone(payload),
    normalizedPayload: parseError ? {} : structuredClone(payload),
  })
}

function enrichDispatchPayload(payload: Record<string, any>, agentId: string | undefined): void {
  if (!payload._terminal) {
    const terminal = detectTerminal()
    payload._terminal = { app: terminal.app, name: terminal.name }
  }
  if (!payload._env) payload._env = buildAllowlistedEnv()
  if (agentId && !payload._agent) payload._agent = agentId
}

interface PreparedDispatch {
  payload: Record<string, any>
  payloadStr: string
  timing: DispatchTiming
}

async function prepareDispatch(
  canonicalEvent: string,
  hookEventName: string,
  agentId: string | undefined,
  t0: number
): Promise<PreparedDispatch> {
  const inboundPayloadStr = await readStdinPayloadWithTimeout()
  const stdinMs = Math.round(performance.now() - t0)
  log(`   ⏱ cli:stdin: ${stdinMs}ms`)
  const { payload, parseError } = parsePayload(inboundPayloadStr)
  if (parseError) {
    captureParsedPayload(canonicalEvent, hookEventName, inboundPayloadStr, payload, true)
  }
  assertDispatchInboundNotParseError(canonicalEvent, parseError)
  const dispatchId = ensureDispatchId(payload)
  const incomingBeforeNormalize = structuredClone(payload)
  normalizeAgentHookPayload(payload)
  await backfillPayloadDefaults(payload)
  if (shouldCaptureIncomingPayloads()) {
    scheduleIncomingDispatchCapture({
      canonicalEvent,
      hookEventName,
      parseError: false,
      payloadStr: inboundPayloadStr,
      incomingBeforeNormalize,
      normalizedPayload: structuredClone(payload),
    })
  }
  enrichDispatchPayload(payload, agentId)
  const timing: DispatchTiming = {
    canonicalEvent,
    hookEventName,
    sessionId: typeof payload.session_id === "string" ? payload.session_id : undefined,
    cwd: payload.cwd as string,
    toolName: (payload.tool_name ?? payload.toolName) as string | undefined,
    dispatchId,
    toolUseId: dispatchToolUseId(payload),
    t0,
    stdinMs,
  }
  return { payload, payloadStr: JSON.stringify(payload), timing }
}

async function handleFastDispatchPaths(
  timing: DispatchTiming,
  payload: Record<string, any>,
  hookEventName: string
): Promise<boolean> {
  if (await tryAutoContinueDisabledFastPath(timing, payload, hookEventName)) return true
  if (await tryStopFastPath(timing, payload)) return true
  if (isStopLikeEvent(timing.canonicalEvent) && timing.sessionId) {
    payload._fastPathTaskScanComplete = true
  }
  return false
}

async function executeLocalDispatch(
  timing: DispatchTiming,
  payload: Record<string, any>,
  payloadStr: string,
  daemonMs: number
): Promise<void> {
  const tLocal = performance.now()
  const { executeDispatch } = await import("../dispatch/execute.ts")
  const { response } = await executeDispatch({
    canonicalEvent: timing.canonicalEvent,
    hookEventName: timing.hookEventName,
    payloadStr,
    preParsedPayload: payload,
  })
  const localMs = Math.round(performance.now() - tLocal)
  const totalMs = Math.round(performance.now() - timing.t0)
  log(`   ⏱ cli:local-execute: ${localMs}ms`)
  log(`   ⏱ cli:total: ${totalMs}ms`)
  void appendCliTimingLog({ ...timing, totalMs, daemonMs, localMs, route: "local" })
  void response
  process.exit(0)
}

async function dispatchPreparedRequest(prepared: PreparedDispatch): Promise<void> {
  const { timing, payload, payloadStr } = prepared
  const tDaemon = performance.now()
  const daemonResponse = await tryDaemonDispatch(
    timing.canonicalEvent,
    timing.hookEventName,
    payloadStr
  )
  const daemonMs = Math.round(performance.now() - tDaemon)
  log(
    `   ⏱ cli:daemon-attempt: ${daemonMs}ms (${daemonResponse === null ? "fallback" : "forwarded"})`
  )
  if (daemonResponse === null) {
    await executeLocalDispatch(timing, payload, payloadStr, daemonMs)
    return
  }
  const agentResponse = sanitizeHookOutputForCurrentAgent(daemonResponse)
  markDispatchResponseWritten()
  process.stdout.write(`${JSON.stringify(agentResponse)}\n`)
  const totalMs = Math.round(performance.now() - timing.t0)
  log(`   ⏱ cli:total: ${totalMs}ms`)
  void appendCliTimingLog({ ...timing, totalMs, daemonMs, route: "daemon" })
}

async function runDispatch(
  canonicalEvent: string,
  hookEventName: string,
  agentId?: string
): Promise<void> {
  const t0 = performance.now()
  maybeForceDispatchFailureForTesting()
  const prepared = await prepareDispatch(canonicalEvent, hookEventName, agentId, t0)
  if (await handleFastDispatchPaths(prepared.timing, prepared.payload, hookEventName)) return
  await dispatchPreparedRequest(prepared)
}

// ─── Command ────────────────────────────────────────────────────────────────

async function runReplayMode(args: string[]): Promise<boolean> {
  if (args[0] !== "replay") return false
  const canonicalEvent = args[1]
  const jsonMode = args.includes("--json")
  if (!canonicalEvent) throw new Error("Usage: swiz dispatch replay <event> [--json]")

  const t0 = performance.now()
  const payloadStr = await readStdinPayloadWithTimeout()
  log(`   ⏱ cli:stdin: ${Math.round(performance.now() - t0)}ms`)
  const { payload, parseError } = parsePayload(payloadStr)
  if (parseError) throw new Error("Replay requires valid JSON object stdin payload")
  normalizeAgentHookPayload(payload)
  await backfillPayloadDefaults(payload)
  const validated = assertNormalizedDispatchPayload(canonicalEvent, payload)
  for (const key of Object.keys(payload)) delete payload[key]
  Object.assign(payload, validated)
  const { toolName, trigger } = getHookContext(canonicalEvent, payload)
  const matchingGroups =
    canonicalEvent === "preToolUse" && isSkillMdOnlyFileEditPayload(toolName, payload)
      ? []
      : manifest.filter(
          (group) => group.event === canonicalEvent && groupMatches(group, toolName, trigger)
        )
  const filteredGroups = await applyHookSettingFilters(matchingGroups, payload)
  const tReplay = performance.now()
  const strategy = DISPATCH_ROUTES[canonicalEvent] ?? "blocking"
  const traces =
    strategy === "preToolUse"
      ? await replayPreToolUse(filteredGroups, payloadStr)
      : strategy === "blocking"
        ? await replayBlocking(filteredGroups, payloadStr, canonicalEvent)
        : await replayContext(filteredGroups, payloadStr)
  log(`   ⏱ cli:replay: ${Math.round(performance.now() - tReplay)}ms`)
  formatTrace(canonicalEvent, strategy, filteredGroups.length, traces, jsonMode)
  log(`   ⏱ cli:total: ${Math.round(performance.now() - t0)}ms`)
  return true
}

interface DispatchInvocation {
  agentId?: string
  canonicalEvent: string
  hookEventName: string
}

function parseDispatchInvocation(args: string[]): DispatchInvocation {
  let agentId: string | undefined
  const filteredArgs: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--agent" && index + 1 < args.length) agentId = args[++index]
    else filteredArgs.push(args[index]!)
  }
  const canonicalEvent = filteredArgs[0]
  if (!canonicalEvent) throw new Error("Usage: swiz dispatch <event> [agentEventName]")
  return {
    agentId,
    canonicalEvent,
    hookEventName: filteredArgs[1] ?? canonicalEvent,
  }
}

interface DispatchFailureContext {
  isReplay: boolean
  canonicalEvent: string
  hookEventName?: string
  scope: string
}

function resolveDispatchFailureContext(args: string[]): DispatchFailureContext {
  const isReplay = args[0] === "replay"
  const canonicalEvent = isReplay ? (args[1] ?? "(missing-event)") : (args[0] ?? "(missing-event)")
  const hookEventName =
    !isReplay && canonicalEvent !== "(missing-event)" ? (args[1] ?? canonicalEvent) : undefined
  const suffix = hookEventName && hookEventName !== canonicalEvent ? ` (${hookEventName})` : ""
  return {
    isReplay,
    canonicalEvent,
    hookEventName,
    scope: isReplay ? `dispatch replay ${canonicalEvent}` : `dispatch ${canonicalEvent}${suffix}`,
  }
}

function writeDispatchFailureResponse(
  context: DispatchFailureContext,
  err: unknown,
  logPath: string
): void {
  if (didWriteDispatchResponse() || !context.hookEventName) return
  try {
    const fallback = buildDispatchFailureFallback(
      context.canonicalEvent,
      context.hookEventName,
      err,
      logPath
    )
    process.stdout.write(`${JSON.stringify(fallback)}\n`)
  } catch {
    const emergencyFallback = buildDispatchFailureFallback(
      context.canonicalEvent,
      context.hookEventName,
      "dispatch fallback generation failed",
      logPath
    )
    process.stdout.write(`${JSON.stringify(emergencyFallback)}\n`)
  }
  markDispatchResponseWritten()
}

async function handleDispatchCommandFailure(args: string[], err: unknown): Promise<void> {
  const context = resolveDispatchFailureContext(args)
  const message = messageFromUnknownError(err)
  if (context.isReplay || context.canonicalEvent === "(missing-event)") {
    stderrLog(
      "dispatch command last-resort failure reporting",
      `Dispatch failed for ${context.scope}: ${message}`
    )
    process.exitCode = 1
    return
  }
  const logPath = await captureDispatchFailure(
    context.scope,
    context.canonicalEvent,
    context.hookEventName,
    err
  )
  stderrLog(
    "dispatch command fail-open reporting",
    `Dispatch failed for ${context.scope}: ${message}. Falling back to allow and capturing details in ${logPath}`
  )
  writeDispatchFailureResponse(context, err, logPath)
  process.exitCode = 0
}

export const dispatchCommand: Command = {
  name: "dispatch",
  description: "Fan out a hook event to all matching scripts (used by agent configs)",
  usage: "swiz dispatch <event> [agentEventName]",
  options: [
    {
      flags: "<event>",
      description:
        "Canonical event name (preToolUse | postToolUse | stop | sessionStart | userPromptSubmit)",
    },
    {
      flags: "[agentEventName]",
      description: "Agent-translated event name injected into hook output (default: <event>)",
    },
    {
      flags: "replay <event>",
      description: "Replay a captured payload and show a hook-by-hook trace",
    },
    {
      flags: "--agent <name>",
      description:
        "Agent id already known by the caller (claude | cursor | gemini | codex). Injects payload._agent so daemon hooks skip env-based detection.",
    },
    {
      flags: "--json",
      description: "Output trace in machine-readable JSON format (replay mode only)",
    },
  ],
  async run(args) {
    try {
      resetDispatchResponseWriteState()
      if (await runReplayMode(args)) return
      const invocation = parseDispatchInvocation(args)
      await withLogBuffer(() =>
        runDispatch(invocation.canonicalEvent, invocation.hookEventName, invocation.agentId)
      )
    } catch (err) {
      await handleDispatchCommandFailure(args, err)
    }
  },
}
