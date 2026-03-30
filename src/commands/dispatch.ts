/**
 * Dispatch command — CLI entry point for `swiz dispatch <event>`.
 *
 * The heavy lifting (filters, engine, replay) lives in src/dispatch/.
 * This file handles CLI parsing, plugin loading, transcript enrichment,
 * and re-exports all public symbols for backward compatibility.
 */

import { debugLog } from "../debug.ts"
import {
  applyHookSettingFilters,
  DISPATCH_ROUTES,
  formatTrace,
  groupMatches,
  log,
  parsePayload,
  replayBlocking,
  replayContext,
  replayPreToolUse,
  withLogBuffer,
} from "../dispatch"
import { getHomeDirOrNull } from "../home.ts"
import { appendHookLog, type HookLogEntry } from "../hook-log.ts"
import { DISPATCH_TIMEOUTS, manifest } from "../manifest.ts"
import type { Command } from "../types.ts"
import { checkIncompleteTasks } from "../utils/stop-incomplete-tasks-core.ts"
import { detectTerminal } from "../utils/terminal-detection.ts"

const DAEMON_PORT = Number(process.env.SWIZ_DAEMON_PORT) || 7943
const DEFAULT_DAEMON_TIMEOUT_MS = 15_000

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

async function tryDaemonDispatch(
  canonicalEvent: string,
  hookEventName: string,
  payloadStr: string
): Promise<Record<string, unknown> | null> {
  if (process.env.SWIZ_NO_DAEMON === "1") {
    debugLog("daemon dispatch: skipped (SWIZ_NO_DAEMON=1)")
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
      debugLog(`daemon dispatch: failed (status ${resp.status}), falling back to local`)
      return null
    }

    const raw: unknown = await resp.json()
    const json =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {}
    debugLog(`daemon dispatch: forwarded ${canonicalEvent} to daemon (${resp.status})`)
    return json
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    debugLog(`daemon dispatch: error (${msg}), falling back to local`)
    return null
  }
}

const STDIN_PAYLOAD_TIMEOUT_MS = 2_000

interface HookContext {
  toolName: string | undefined
  trigger: string | undefined
}

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

function getHookContext(canonicalEvent: string, payload: Record<string, unknown>): HookContext {
  const toolName = (payload.tool_name ?? payload.toolName) as string | undefined
  const trigger =
    canonicalEvent === "sessionStart"
      ? ((payload.trigger ?? payload.hook_event_name) as string | undefined)
      : undefined
  return { toolName, trigger }
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
  const payloadStr = await readStdinPayloadWithTimeout()
  const stdinMs = Math.round(performance.now() - t0)
  log(`   ⏱ cli:stdin: ${stdinMs}ms`)

  const { payload } = parsePayload(payloadStr)
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined
  // Inject CLI process cwd into payload when agent didn't provide it.
  // The CLI runs in the project directory (Cursor/Claude launches it there),
  // so process.cwd() is the correct project path. The daemon's process.cwd()
  // is the swiz installation root — without this injection, hooks would
  // operate on the wrong repository.
  if (!payload.cwd) {
    payload.cwd = process.cwd()
  }
  const cwd = payload.cwd as string
  const toolName = (payload.tool_name ?? payload.toolName) as string | undefined

  // Inject terminal info from the CLI process environment (daemon doesn't have these env vars)
  if (!payload._terminal) {
    const terminal = detectTerminal()
    payload._terminal = { app: terminal.app, name: terminal.name }
  }
  // Inject caller's environment so daemon-spawned hooks inherit the full
  // shell env (LaunchAgent only gets a minimal set of env vars).
  if (!payload._env) {
    payload._env = { ...process.env }
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

  // ── Try daemon first, fall back to local execution ──
  const tDaemon = performance.now()
  const daemonResponse = await tryDaemonDispatch(canonicalEvent, hookEventName, enrichedPayloadStr)
  const daemonMs = Math.round(performance.now() - tDaemon)
  const forwarded = daemonResponse !== null
  log(`   ⏱ cli:daemon-attempt: ${daemonMs}ms (${forwarded ? "forwarded" : "fallback"})`)

  if (daemonResponse !== null) {
    // Mirror engine `writeResponse`: always emit one JSON line (even `{}`).
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

      const { payload } = parsePayload(payloadStr)
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
  },
}
