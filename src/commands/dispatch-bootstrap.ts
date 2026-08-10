/**
 * Thin daemon-first bootstrap for non-stop hook dispatches.
 *
 * The normal CLI command registry imports the manifest and every command. A
 * hook invocation that can be served by the already-running daemon does not
 * need that graph, so this module performs only wire enrichment, capture,
 * transport, and response serialization. The established dispatcher remains
 * the fallback for local execution and route validation.
 */

import { appendFile } from "node:fs/promises"
import { ensureDispatchId } from "../dispatch/dispatch-id.ts"
import {
  scheduleIncomingDispatchCapture,
  shouldCaptureIncomingPayloads,
} from "../dispatch/incoming-capture.ts"
import { normalizeAgentHookPayload } from "../dispatch/payload-normalize.ts"
import { DISPATCH_TIMEOUTS } from "../dispatch/timeouts.ts"
import { swizDispatchLogPath } from "../temp-paths.ts"
import { sanitizeHookOutputForCurrentAgent } from "../utils/hook-output-agent-compat.ts"
import { detectTerminal } from "../utils/terminal-detection.ts"

const DEFAULT_DAEMON_PORT = 7_943
const DEFAULT_DAEMON_TIMEOUT_MS = 30_000
const STDIN_PAYLOAD_TIMEOUT_MS = 2_000

interface ParsedDispatchArgs {
  agentId?: string
  canonicalEvent: string
  hookEventName: string
}

function parseDispatchArgs(args: string[]): ParsedDispatchArgs {
  let agentId: string | undefined
  const positional: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--agent" && index + 1 < args.length) {
      agentId = args[++index]
    } else {
      positional.push(args[index]!)
    }
  }

  const canonicalEvent = positional[0]
  if (!canonicalEvent) throw new Error("Usage: swiz dispatch <event> [agentEventName]")
  return {
    agentId,
    canonicalEvent,
    hookEventName: positional[1] ?? canonicalEvent,
  }
}

async function readStdinPayload(): Promise<string> {
  const reader = Bun.stdin.stream().getReader()
  const decoder = new TextDecoder()
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      void reader.cancel().catch(() => {})
      reject(new Error("Timed out waiting 2s for stdin JSON payload to be received"))
    }, STDIN_PAYLOAD_TIMEOUT_MS)
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
  })()

  try {
    return await Promise.race([readAll, timeout])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

function parsePayload(payloadStr: string, canonicalEvent: string): Record<string, any> {
  let value: unknown
  try {
    value = JSON.parse(payloadStr || "{}")
  } catch {
    throw new Error(`Invalid dispatch payload for event "${canonicalEvent}"`)
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid dispatch payload for event "${canonicalEvent}"`)
  }
  return value as Record<string, any>
}

function trackInferred(payload: Record<string, any>, field: string): void {
  const fields = Array.isArray(payload._inferredFields) ? (payload._inferredFields as string[]) : []
  if (!fields.includes(field)) fields.push(field)
  payload._inferredFields = fields
}

async function backfillPayload(payload: Record<string, any>): Promise<void> {
  const hasSessionId = typeof payload.session_id === "string" && payload.session_id.trim() !== ""
  if (!hasSessionId) {
    const { backfillPayloadDefaults } = await import("../dispatch/payload-backfill.ts")
    await backfillPayloadDefaults(payload)
    return
  }

  if (typeof payload.cwd === "string" && payload.cwd.trim() !== "") return
  payload.cwd =
    process.env.GEMINI_CWD ||
    process.env.GEMINI_PROJECT_DIR ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd()
  trackInferred(payload, "cwd")
}

function buildAllowlistedEnv(): Record<string, string> {
  const result: Record<string, string> = {}
  const patterns = [
    /^PATH$/,
    /^HOME$/,
    /^(TERM|COLORTERM)$/,
    /^SWIZ_/,
    /^ANTHROPIC_/,
    /^CURSOR_/,
    /^CODEX_/,
    /^GEMINI_/,
    /^CLAUDECODE$/,
    /^CLAUDE_PROJECT_DIR$/,
  ]
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && patterns.some((pattern) => pattern.test(key))) result[key] = value
  }
  return result
}

function daemonPort(): number {
  const parsed = Number(process.env.SWIZ_DAEMON_PORT)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAEMON_PORT
}

async function tryDaemonDispatch(
  canonicalEvent: string,
  hookEventName: string,
  payloadStr: string
): Promise<Record<string, any> | null> {
  if (process.env.SWIZ_NO_DAEMON === "1") return null

  const timeoutMs = (DISPATCH_TIMEOUTS[canonicalEvent] ?? DEFAULT_DAEMON_TIMEOUT_MS / 1000) * 1000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(
      `http://127.0.0.1:${daemonPort()}/dispatch?event=${encodeURIComponent(canonicalEvent)}&hookEventName=${encodeURIComponent(hookEventName)}`,
      {
        method: "POST",
        body: payloadStr,
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
      }
    )
    if (!response.ok) return null
    const value: unknown = await response.json()
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, any>)
      : {}
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function executeLocalFallback(
  canonicalEvent: string,
  hookEventName: string,
  payload: Record<string, any>
): Promise<void> {
  const [{ CONFIGURABLE_AGENTS }, { DISPATCH_ROUTES }, engine, manifestModule, executeModule] =
    await Promise.all([
      import("../agents.ts"),
      import("../dispatch/index.ts"),
      import("../dispatch/engine.ts"),
      import("../manifest.ts"),
      import("../dispatch/execute.ts"),
    ])
  manifestModule.validateDispatchRoutes(DISPATCH_ROUTES, CONFIGURABLE_AGENTS)
  const payloadStr = JSON.stringify(payload)
  await engine.withLogBuffer(async () => {
    await executeModule.executeDispatch({
      canonicalEvent,
      hookEventName,
      payloadStr,
      preParsedPayload: payload,
    })
  })
}

function supportsHookSpecificOutput(canonicalEvent: string): boolean {
  return ["preToolUse", "postToolUse", "userPromptSubmit", "postToolBatch"].includes(canonicalEvent)
}

async function failOpen(
  canonicalEvent: string,
  hookEventName: string,
  err: unknown
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  const logPath = swizDispatchLogPath()
  const detail = [
    "",
    `── ${new Date().toISOString()} ── dispatch failure ──`,
    `   scope: dispatch ${canonicalEvent}`,
    `   event: ${canonicalEvent}`,
    `   hookEventName: ${hookEventName}`,
    `   pid: ${process.pid}`,
    `   cwd: ${process.cwd()}`,
    `   ${err instanceof Error ? (err.stack ?? message) : message}`,
    "",
  ].join("\n")
  try {
    await appendFile(logPath, detail)
  } catch {}

  const systemMessage = `Dispatch runtime failure in ${canonicalEvent}. Allowed by fallback; details captured in ${logPath}.`
  const response = supportsHookSpecificOutput(canonicalEvent)
    ? {
        systemMessage,
        hookSpecificOutput: {
          hookEventName,
          additionalContext: `Dispatch failed: ${message}. See ${logPath}.`,
        },
      }
    : { systemMessage: `${systemMessage} Dispatch failed: ${message}. See ${logPath}.` }
  process.stderr.write(
    `Dispatch failed for dispatch ${canonicalEvent}: ${message}. Falling back to allow and capturing details in ${logPath}\n`
  )
  process.stdout.write(`${JSON.stringify(response)}\n`)
  process.exitCode = 0
}

export async function runThinDispatch(
  args: string[],
  processStartedAt: number = performance.now()
): Promise<void> {
  let canonicalEvent = args[0] ?? "(missing-event)"
  let hookEventName = canonicalEvent
  try {
    const parsedArgs = parseDispatchArgs(args)
    canonicalEvent = parsedArgs.canonicalEvent
    hookEventName = parsedArgs.hookEventName
    const rawPayloadStr = await readStdinPayload()
    let payload: Record<string, any>
    try {
      payload = parsePayload(rawPayloadStr, canonicalEvent)
    } catch (error) {
      if (shouldCaptureIncomingPayloads()) {
        scheduleIncomingDispatchCapture({
          canonicalEvent,
          hookEventName,
          parseError: true,
          payloadStr: rawPayloadStr,
          incomingBeforeNormalize: null,
          normalizedPayload: {},
        })
      }
      throw error
    }
    ensureDispatchId(payload)
    const incomingBeforeNormalize = structuredClone(payload)
    normalizeAgentHookPayload(payload)
    await backfillPayload(payload)
    const normalizedPayload = structuredClone(payload)

    if (shouldCaptureIncomingPayloads()) {
      scheduleIncomingDispatchCapture({
        canonicalEvent,
        hookEventName,
        parseError: false,
        payloadStr: rawPayloadStr,
        incomingBeforeNormalize,
        normalizedPayload,
      })
    }

    if (!payload._terminal) {
      const terminal = detectTerminal()
      payload._terminal = { app: terminal.app, name: terminal.name }
    }
    if (!payload._env) payload._env = buildAllowlistedEnv()
    if (parsedArgs.agentId && !payload._agent) payload._agent = parsedArgs.agentId
    payload._swizTiming = {
      cliBootstrapMs: Math.max(0, performance.now() - processStartedAt),
    }

    const response = await tryDaemonDispatch(canonicalEvent, hookEventName, JSON.stringify(payload))
    if (response !== null) {
      process.stdout.write(`${JSON.stringify(sanitizeHookOutputForCurrentAgent(response))}\n`)
      return
    }

    await executeLocalFallback(canonicalEvent, hookEventName, payload)
    process.exit(0)
  } catch (err) {
    await failOpen(canonicalEvent, hookEventName, err)
  }
}
