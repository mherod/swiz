/**
 * Dispatch command — CLI entry point for `swiz dispatch <event>`.
 *
 * The heavy lifting (filters, engine, replay) lives in src/dispatch/.
 * This file handles CLI parsing, plugin loading, transcript enrichment,
 * and re-exports all public symbols for backward compatibility.
 */

import { appendFile } from "node:fs/promises"
import { debugLog, stderrLog } from "../debug.ts"
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
  replayBlocking,
  replayContext,
  replayPreToolUse,
  resetDispatchResponseWriteState,
  shouldCaptureIncomingPayloads,
  withLogBuffer,
} from "../dispatch"
import { writeIncomingDispatchCapture } from "../dispatch/incoming-capture.ts"
import { getHomeDirOrNull } from "../home.ts"
import { appendHookLog, type HookLogEntry } from "../hook-log.ts"
import { DISPATCH_TIMEOUTS, manifest } from "../manifest.ts"
import { swizDispatchLogPath } from "../temp-paths.ts"
import type { Command } from "../types.ts"
import { messageFromUnknownError } from "../utils/hook-json-helpers.ts"
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
  t0: number
  stdinMs: number
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
  const response = isStopLikeEvent(canonicalEvent)
    ? {
        continue: true,
        reason: message,
        stopReason: message,
        systemMessage,
      }
    : {
        systemMessage,
        hookSpecificOutput: {
          hookEventName,
          additionalContext: `Dispatch failed: ${message}. See ${logPath}.`,
        },
      }
  return response
}

function maybeForceDispatchFailureForTesting(): void {
  if (process.env.SWIZ_TEST_FORCE_DISPATCH_FAILURE === "1") {
    throw new Error("forced dispatch failure")
  }
}

/** In-process incomplete-tasks check — skips daemon round-trip when tasks block. */
async function tryStopFastPath(timing: DispatchTiming): Promise<boolean> {
  const { canonicalEvent, sessionId } = timing
  if (canonicalEvent !== "stop" || !sessionId) return false

  const home = getHomeDirOrNull()
  if (!home) return false

  const tFast = performance.now()
  const blockResult = await checkIncompleteTasks(sessionId, home)
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

async function runDispatch(canonicalEvent: string, hookEventName: string): Promise<void> {
  const t0 = performance.now()
  maybeForceDispatchFailureForTesting()
  const payloadStr = await readStdinPayloadWithTimeout()
  const stdinMs = Math.round(performance.now() - t0)
  log(`   ⏱ cli:stdin: ${stdinMs}ms`)

  const { payload, parseError } = parsePayload(payloadStr)
  assertDispatchInboundNotParseError(canonicalEvent, parseError)
  const incomingBeforeNormalize = structuredClone(payload)
  normalizeAgentHookPayload(payload)
  // Recover/infer missing required fields from env vars, the dispatch route,
  // and camelCase→snake_case aliases. The CLI runs in the project directory
  // (Cursor/Claude launch it there), so `process.cwd()` is the correct project
  // path. The daemon's own `process.cwd()` is the swiz installation root —
  // without this step, hooks would operate on the wrong repository.
  await backfillPayloadDefaults(payload)
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined
  const cwd = payload.cwd as string
  const toolName = (payload.tool_name ?? payload.toolName) as string | undefined
  const normalizedPayloadForCapture = structuredClone(payload)

  if (shouldCaptureIncomingPayloads()) {
    await writeIncomingDispatchCapture({
      canonicalEvent,
      hookEventName,
      parseError: false,
      payloadStr,
      incomingBeforeNormalize,
      normalizedPayload: normalizedPayloadForCapture,
    })
  }

  // Inject terminal info from the CLI process environment (daemon doesn't have these env vars)
  if (!payload._terminal) {
    const terminal = detectTerminal()
    payload._terminal = { app: terminal.app, name: terminal.name }
  }
  // Inject caller's environment so daemon-spawned hooks inherit necessary
  // env vars (LaunchAgent only gets a minimal set of env vars).
  // Use an allowlist to avoid cloning ~50-200KB per dispatch in LaunchAgent mode.
  if (!payload._env) {
    payload._env = buildAllowlistedEnv()
  }
  const enrichedPayloadStr = JSON.stringify(payload)

  const timing: DispatchTiming = {
    canonicalEvent,
    hookEventName,
    sessionId,
    cwd,
    toolName,
    t0,
    stdinMs,
  }

  // ── Fast path: in-process incomplete-tasks check for stop events ──
  if (await tryStopFastPath(timing)) return
  // Signal to hooks that the fast path already scanned tasks (no blockers found)
  if (canonicalEvent === "stop" && sessionId) {
    payload._fastPathTaskScanComplete = true
  }

  // ── Try daemon first, fall back to local execution ──
  const tDaemon = performance.now()
  const daemonResponse = await tryDaemonDispatch(canonicalEvent, hookEventName, enrichedPayloadStr)
  const daemonMs = Math.round(performance.now() - tDaemon)
  const forwarded = daemonResponse !== null
  log(`   ⏱ cli:daemon-attempt: ${daemonMs}ms (${forwarded ? "forwarded" : "fallback"})`)

  if (daemonResponse !== null) {
    // Mirror engine `writeResponse`: always emit one JSON line (even `{}`).
    markDispatchResponseWritten()
    process.stdout.write(`${JSON.stringify(daemonResponse)}\n`)
    const totalMs = Math.round(performance.now() - t0)
    log(`   ⏱ cli:total: ${totalMs}ms`)
    void appendCliTimingLog({ ...timing, totalMs, daemonMs, route: "daemon" })
    return
  }

  // ── Local execution fallback ──
  const tLocal = performance.now()
  const { executeDispatch } = await import("../dispatch/execute.ts")
  const { response } = await executeDispatch({
    canonicalEvent,
    hookEventName,
    payloadStr: enrichedPayloadStr,
    preParsedPayload: payload,
  })
  const localMs = Math.round(performance.now() - tLocal)
  const totalMs = Math.round(performance.now() - t0)
  log(`   ⏱ cli:local-execute: ${localMs}ms`)
  log(`   ⏱ cli:total: ${totalMs}ms`)
  void appendCliTimingLog({ ...timing, totalMs, daemonMs, localMs, route: "local" })
  // Response already written to stdout by engine strategy functions.
  // The returned response is used only by the daemon path above.
  void response
  // In CLI mode, exit immediately — open resources (SQLite handles,
  // fire-and-forget hook subprocesses) would otherwise keep Bun alive.
  process.exit(0)
}

// ─── Command ────────────────────────────────────────────────────────────────

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
      flags: "--json",
      description: "Output trace in machine-readable JSON format (replay mode only)",
    },
  ],
  async run(args) {
    try {
      resetDispatchResponseWriteState()
      // ─── Replay mode ─────────────────────────────────────────────────────
      if (args[0] === "replay") {
        const canonicalEvent = args[1]
        const jsonMode = args.includes("--json")
        if (!canonicalEvent) {
          throw new Error("Usage: swiz dispatch replay <event> [--json]")
        }

        const t0 = performance.now()
        const payloadStr = await readStdinPayloadWithTimeout()
        log(`   ⏱ cli:stdin: ${Math.round(performance.now() - t0)}ms`)

        const { payload, parseError } = parsePayload(payloadStr)
        if (parseError) {
          throw new Error("Replay requires valid JSON object stdin payload")
        }
        normalizeAgentHookPayload(payload)
        await backfillPayloadDefaults(payload)
        const validated = assertNormalizedDispatchPayload(canonicalEvent, payload)
        for (const k of Object.keys(payload)) delete payload[k]
        Object.assign(payload, validated)
        const { toolName, trigger } = getHookContext(canonicalEvent, payload)

        const matchingGroups = manifest.filter(
          (g) => g.event === canonicalEvent && groupMatches(g, toolName, trigger)
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
        return
      }

      const canonicalEvent = args[0]
      if (!canonicalEvent) {
        throw new Error("Usage: swiz dispatch <event> [agentEventName]")
      }
      const hookEventName = args[1] ?? canonicalEvent

      await withLogBuffer(() => runDispatch(canonicalEvent, hookEventName))
    } catch (err) {
      const isReplay = args[0] === "replay"
      const canonicalEvent = isReplay
        ? (args[1] ?? "(missing-event)")
        : (args[0] ?? "(missing-event)")
      const hookEventName =
        !isReplay && canonicalEvent !== "(missing-event)" ? (args[1] ?? canonicalEvent) : undefined
      const message = messageFromUnknownError(err)
      const scope = isReplay
        ? `dispatch replay ${canonicalEvent}`
        : `dispatch ${canonicalEvent}${hookEventName && hookEventName !== canonicalEvent ? ` (${hookEventName})` : ""}`

      if (isReplay || canonicalEvent === "(missing-event)") {
        stderrLog(
          "dispatch command last-resort failure reporting",
          `Dispatch failed for ${scope}: ${message}`
        )
        process.exitCode = 1
        return
      }

      const logPath = await captureDispatchFailure(scope, canonicalEvent, hookEventName, err)
      stderrLog(
        "dispatch command fail-open reporting",
        `Dispatch failed for ${scope}: ${message}. Falling back to allow and capturing details in ${logPath}`
      )

      if (!didWriteDispatchResponse()) {
        try {
          const fallback = buildDispatchFailureFallback(
            canonicalEvent,
            hookEventName!,
            err,
            logPath
          )
          process.stdout.write(`${JSON.stringify(fallback)}\n`)
          markDispatchResponseWritten()
        } catch {
          const emergencyFallback = buildDispatchFailureFallback(
            canonicalEvent,
            hookEventName!,
            "dispatch fallback generation failed",
            logPath
          )
          process.stdout.write(`${JSON.stringify(emergencyFallback)}\n`)
          markDispatchResponseWritten()
        }
      }

      process.exitCode = 0
    }
  },
}
