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
import { gitHookBlockReason } from "../dispatch/git-hook-events.ts"
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

/**
 * Git only reads a hook's exit status, so a block on a git-hook event is spelled out on stderr
 * and the caller must exit non-zero. Agent events are untouched: they act on the JSON response.
 */
function reportGitHookBlock(canonicalEvent: string, response: unknown): boolean {
  const reason = gitHookBlockReason(canonicalEvent, response)
  if (reason === null) return false
  process.stderr.write(`swiz ${canonicalEvent} blocked this git operation:\n${reason}\n`)
  return true
}

async function executeLocalFallback(
  canonicalEvent: string,
  hookEventName: string,
  payload: Record<string, any>
): Promise<Record<string, any>> {
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
  let response: Record<string, any> = {}
  await engine.withLogBuffer(async () => {
    const result = await executeModule.executeDispatch({
      canonicalEvent,
      hookEventName,
      payloadStr,
      preParsedPayload: payload,
    })
    response = result.response
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
  return response
}

/**
 * Local execution has the same deadline as the daemon path. Without one, a
 * daemon that is down or restarting turns every hook call into an unbounded
 * local run of the whole manifest, which is exactly when the machine is
 * already struggling. On expiry the call is allowed, like a daemon timeout.
 *
 * Returns the local response, or null when the budget expired first.
 */
async function runLocalFallbackWithinBudget(
  canonicalEvent: string,
  hookEventName: string,
  payload: Record<string, any>
): Promise<Record<string, any> | null> {
  const budgetMs = daemonClientTimeoutMs(canonicalEvent)
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs)
  })
  const local = executeLocalFallback(canonicalEvent, hookEventName, payload)
  const outcome = await Promise.race([local, expired])
  clearTimeout(timer)
  if (outcome !== null) return outcome
  // The caller exits next, so the abandoned run cannot write a second response.
  local.catch(() => {})
  process.stderr.write(
    `swiz local dispatch for ${canonicalEvent} exceeded ${budgetMs}ms; allowing without waiting further\n`
  )
  const { didWriteDispatchResponse } = await import("../dispatch/cli-output.ts")
  if (!didWriteDispatchResponse()) process.stdout.write("{}\n")
  return null
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
      if (reportGitHookBlock(canonicalEvent, result.response)) process.exitCode = 1
      return
    }
    if (
      result.kind === "timeout" &&
      daemonDispatchPolicy(canonicalEvent).timeoutFallback === "allow"
    ) {
      process.stderr.write(
        result.skipped
          ? `swiz daemon timed out on a recent dispatch; skipping it for ${canonicalEvent} and allowing without local re-run\n`
          : `swiz daemon did not answer ${canonicalEvent} within ${daemonClientTimeoutMs(canonicalEvent)}ms; allowing without local re-run\n`
      )
      process.stdout.write("{}\n")
      return
    }

    const localResponse = await runLocalFallbackWithinBudget(canonicalEvent, hookEventName, payload)
    process.exit(reportGitHookBlock(canonicalEvent, localResponse) ? 1 : 0)
  } catch (err) {
    await flushIncomingDispatchCaptures()
    await failOpen(canonicalEvent, hookEventName, err)
  }
}
