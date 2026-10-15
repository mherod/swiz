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
import {
  daemonClientTimeoutMs,
  daemonDispatchPolicy,
  enrichDispatchPayload,
  tryDaemonDispatch,
} from "../dispatch/daemon-client.ts"
import { ensureDispatchId } from "../dispatch/dispatch-id.ts"
import {
  flushIncomingDispatchCaptures,
  scheduleIncomingDispatchCapture,
  shouldCaptureIncomingPayloads,
} from "../dispatch/incoming-capture.ts"
import { normalizeAgentHookPayload } from "../dispatch/payload-normalize.ts"

export { daemonClientTimeoutMs } from "../dispatch/daemon-client.ts"

import { swizDispatchLogPath } from "../temp-paths.ts"
import { sanitizeHookOutputForCurrentAgent } from "../utils/hook-output-agent-compat.ts"
import { supportsHookSpecificOutput } from "../utils/hook-specific-output.ts"

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

async function executeLocalFallback(
  canonicalEvent: string,
  hookEventName: string,
  payload: Record<string, any>
): Promise<void> {
  const [
    { CONFIGURABLE_AGENTS },
    dispatchModule,
    engine,
    manifestModule,
    executeModule,
    agentPaths,
  ] = await Promise.all([
    import("../agents.ts"),
    import("../dispatch/index.ts"),
    import("../dispatch/engine.ts"),
    import("../manifest.ts"),
    import("../dispatch/execute.ts"),
    import("../agent-paths.ts"),
  ])
  manifestModule.validateDispatchRoutes(dispatchModule.DISPATCH_ROUTES, CONFIGURABLE_AGENTS)
  const payloadStr = JSON.stringify(payload)
  await engine.withLogBuffer(async () => {
    const result = await executeModule.executeDispatch({
      canonicalEvent,
      hookEventName,
      payloadStr,
      preParsedPayload: payload,
    })
    if (result.timing.hookCount > 0 || Object.keys(result.response).length > 0) {
      engine.writeResponse(
        dispatchModule.parseValidatedAgentDispatchWireJson(
          result.response,
          canonicalEvent,
          hookEventName,
          agentPaths.detectCurrentAgentFromHookPayload(payload)?.id
        )
      )
    }
  })
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

function captureInvalidPayload(
  canonicalEvent: string,
  hookEventName: string,
  rawPayloadStr: string
): void {
  if (!shouldCaptureIncomingPayloads()) return
  scheduleIncomingDispatchCapture({
    canonicalEvent,
    hookEventName,
    parseError: true,
    payloadStr: rawPayloadStr,
    incomingBeforeNormalize: null,
    normalizedPayload: {},
  })
}

async function preparePayload(
  rawPayloadStr: string,
  canonicalEvent: string,
  hookEventName: string
): Promise<Record<string, any>> {
  let payload: Record<string, any>
  try {
    payload = parsePayload(rawPayloadStr, canonicalEvent)
  } catch (error) {
    captureInvalidPayload(canonicalEvent, hookEventName, rawPayloadStr)
    throw error
  }

  ensureDispatchId(payload)
  const incomingBeforeNormalize = structuredClone(payload)
  normalizeAgentHookPayload(payload)
  await backfillPayload(payload)
  if (shouldCaptureIncomingPayloads()) {
    scheduleIncomingDispatchCapture({
      canonicalEvent,
      hookEventName,
      parseError: false,
      payloadStr: rawPayloadStr,
      incomingBeforeNormalize,
      normalizedPayload: structuredClone(payload),
    })
  }
  return payload
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
    const payload = await preparePayload(rawPayloadStr, canonicalEvent, hookEventName)
    enrichDispatchPayload(payload, parsedArgs.agentId, processStartedAt)

    const result = await tryDaemonDispatch(canonicalEvent, hookEventName, JSON.stringify(payload))
    if (result.kind === "response") {
      process.stdout.write(
        `${JSON.stringify(sanitizeHookOutputForCurrentAgent(result.response))}\n`
      )
      return
    }
    if (
      result.kind === "timeout" &&
      daemonDispatchPolicy(canonicalEvent).timeoutFallback === "allow"
    ) {
      process.stderr.write(
        `swiz daemon did not answer ${canonicalEvent} within ${daemonClientTimeoutMs(canonicalEvent)}ms; allowing without local re-run\n`
      )
      process.stdout.write("{}\n")
      return
    }

    await executeLocalFallback(canonicalEvent, hookEventName, payload)
    process.exit(0)
  } catch (err) {
    await flushIncomingDispatchCaptures()
    await failOpen(canonicalEvent, hookEventName, err)
  }
}
