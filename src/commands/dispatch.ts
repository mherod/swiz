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
  detectCurrentAgentFromHookPayload,
  shouldEnforceIncompleteTasksForHookPayload,
  taskToolNameForHookPayload,
} from "../agent-paths.ts"
import { stderrLog } from "../debug.ts"
import {
  applyHookSettingFilters,
  assertDispatchInboundNotParseError,
  assertNormalizedDispatchPayload,
  backfillPayloadDefaults,
  DISPATCH_ROUTES,
  didWriteDispatchResponse,
  formatTrace,
  getHookContext,
  groupMatches,
  log,
  markDispatchResponseWritten,
  normalizeAgentHookPayload,
  parsePayload,
  parseValidatedAgentDispatchWireJson,
  replayBlocking,
  replayContext,
  replayPreToolUse,
  resetDispatchResponseWriteState,
  shouldCaptureIncomingPayloads,
  withLogBuffer,
} from "../dispatch"
import { writeResponse } from "../dispatch/cli-output.ts"
import {
  daemonClientTimeoutMs,
  daemonDispatchPolicy,
  enrichDispatchPayload,
  tryDaemonDispatch,
} from "../dispatch/daemon-client.ts"
import { dispatchToolUseId, ensureDispatchId } from "../dispatch/dispatch-id.ts"
import {
  flushIncomingDispatchCaptures,
  scheduleIncomingDispatchCapture,
} from "../dispatch/incoming-capture.ts"
import { getHomeDirOrNull } from "../home.ts"
import { appendHookLog, type HookLogEntry } from "../hook-log.ts"
import { manifest } from "../manifest.ts"
import { swizDispatchLogPath } from "../temp-paths.ts"
import { isSkillMdOnlyFileEditPayload } from "../tool-matchers.ts"
import type { Command } from "../types.ts"
import { getEffectiveSwizSettingsForToolHook } from "../utils/hook-effective-settings.ts"
import { messageFromUnknownError } from "../utils/hook-json-helpers.ts"
import { sanitizeHookOutputForCurrentAgent } from "../utils/hook-output-agent-compat.ts"
import { supportsHookSpecificOutput } from "../utils/hook-specific-output.ts"
import { checkIncompleteTasks } from "../utils/stop-incomplete-tasks-core.ts"

export { resetDaemonBackoff } from "../dispatch/daemon-client.ts"

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
  prepareMs: number
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
      `prepare: ${info.prepareMs}ms`,
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
  prepareMs: number
}

function isStopLikeEvent(canonicalEvent: string): boolean {
  return canonicalEvent === "stop" || canonicalEvent === "subagentStop"
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

  // Disabled auto-continue skips task continuation, but must still reach the git gate.
  try {
    const effective = await getEffectiveSwizSettingsForToolHook({
      cwd: timing.cwd,
      session_id: sessionId,
      payload,
    })
    if (effective.autoContinue === false) return false
  } catch {}

  const home = getHomeDirOrNull()
  if (!home) return false

  const tFast = performance.now()
  const blockResult = await checkIncompleteTasks(sessionId, home, {
    cwd: timing.cwd,
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

interface PreparedDispatch {
  payload: Record<string, any>
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
  const tPrepare = performance.now()
  const { payload, parseError } = parsePayload(inboundPayloadStr)
  if (parseError) {
    captureParsedPayload(canonicalEvent, hookEventName, inboundPayloadStr, payload, true)
  }
  assertDispatchInboundNotParseError(canonicalEvent, parseError)
  const dispatchId = ensureDispatchId(payload)
  const incomingBeforeNormalize = structuredClone(payload)
  const tNormalize = performance.now()
  normalizeAgentHookPayload(payload)
  await backfillPayloadDefaults(payload)
  log(`   ⏱ cli:normalize: ${Math.round(performance.now() - tNormalize)}ms`)
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
  const tEnrich = performance.now()
  enrichDispatchPayload(payload, agentId)
  log(`   ⏱ cli:enrich: ${Math.round(performance.now() - tEnrich)}ms`)
  const prepareMs = Math.round(performance.now() - tPrepare)
  log(`   ⏱ cli:prepare: ${prepareMs}ms`)
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
    prepareMs,
  }
  return { payload, timing }
}

async function handleFastDispatchPaths(
  timing: DispatchTiming,
  payload: Record<string, any>
): Promise<boolean> {
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
  log(`   ⏱ cli:local-import: ${Math.round(performance.now() - tLocal)}ms`)
  const tExecute = performance.now()
  const { response, timing: executionTiming } = await executeDispatch({
    canonicalEvent: timing.canonicalEvent,
    hookEventName: timing.hookEventName,
    payloadStr,
    preParsedPayload: payload,
  })
  const localMs = Math.round(performance.now() - tLocal)
  const totalMs = Math.round(performance.now() - timing.t0)
  log(`   ⏱ cli:local-execute: ${Math.round(performance.now() - tExecute)}ms`)
  log(`   ⏱ cli:total: ${totalMs}ms`)
  void appendCliTimingLog({ ...timing, totalMs, daemonMs, localMs, route: "local" })
  if (executionTiming.hookCount > 0 || Object.keys(response).length > 0) {
    writeResponse(
      parseValidatedAgentDispatchWireJson(
        response,
        timing.canonicalEvent,
        timing.hookEventName,
        detectCurrentAgentFromHookPayload(payload)?.id
      )
    )
  }
  process.exit(0)
}

async function dispatchPreparedRequest(prepared: PreparedDispatch): Promise<void> {
  const { timing, payload } = prepared
  const payloadStr = JSON.stringify(payload)
  const tDaemon = performance.now()
  const daemonResponse = await tryDaemonDispatch(
    timing.canonicalEvent,
    timing.hookEventName,
    payloadStr
  )
  const daemonMs = Math.round(performance.now() - tDaemon)
  log(`   ⏱ cli:daemon-attempt: ${daemonMs}ms (${daemonResponse.kind})`)
  if (
    daemonResponse.kind === "unavailable" ||
    (daemonResponse.kind === "timeout" &&
      daemonDispatchPolicy(timing.canonicalEvent).timeoutFallback === "local")
  ) {
    await executeLocalDispatch(timing, payload, payloadStr, daemonMs)
    return
  }
  if (daemonResponse.kind === "timeout") {
    process.stderr.write(
      `swiz daemon did not answer ${timing.canonicalEvent} within ${daemonClientTimeoutMs(timing.canonicalEvent)}ms; allowing without local re-run\n`
    )
    writeResponse({})
    return
  }
  if (daemonResponse.kind !== "response") return
  const agentResponse = sanitizeHookOutputForCurrentAgent(daemonResponse.response)
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
  const tFastPaths = performance.now()
  let handled: boolean
  try {
    handled = await handleFastDispatchPaths(prepared.timing, prepared.payload)
  } finally {
    log(`   ⏱ cli:fast-paths: ${Math.round(performance.now() - tFastPaths)}ms`)
  }
  if (handled) return
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
  await flushIncomingDispatchCaptures()
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
