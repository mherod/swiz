/** Lightweight transport shared by both CLI entry points; no manifest or engine imports. */
import { detectTerminal } from "../utils/terminal-detection.ts"
import { DISPATCH_TIMEOUTS } from "./timeouts.ts"

const BACKOFF_MS = 30_000
let lastDaemonFailureAt = 0

export function resetDaemonBackoff(): void {
  lastDaemonFailureAt = 0
}

/** Stop retains its local checks on transport timeout; other hooks avoid a second execution. */
export function daemonDispatchPolicy(canonicalEvent: string): {
  timeoutMs: number
  timeoutFallback: "local" | "allow"
} {
  const budgetMs = (DISPATCH_TIMEOUTS[canonicalEvent] ?? 30) * 1000
  const stop = canonicalEvent === "stop" || canonicalEvent === "subagentStop"
  return {
    timeoutMs: Math.max(1000, budgetMs - 3000),
    timeoutFallback: stop ? "local" : "allow",
  }
}

export function daemonClientTimeoutMs(canonicalEvent: string): number {
  return daemonDispatchPolicy(canonicalEvent).timeoutMs
}

export type DaemonDispatchResult =
  | { kind: "response"; response: Record<string, any> }
  | { kind: "unavailable" }
  | { kind: "timeout" }

function daemonUnavailable(): boolean {
  return (
    process.env.SWIZ_NO_DAEMON === "1" ||
    (lastDaemonFailureAt > 0 && Date.now() - lastDaemonFailureAt < BACKOFF_MS)
  )
}

function daemonPort(): number {
  const port = Number(process.env.SWIZ_DAEMON_PORT)
  return Number.isFinite(port) && port > 0 ? port : 7943
}

function normalizeDaemonResponse(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {}
}

export async function tryDaemonDispatch(
  canonicalEvent: string,
  hookEventName: string,
  payloadStr: string,
  options: {
    timeoutMs?: number
    fetch?: (url: string, init: RequestInit) => Promise<Response>
  } = {}
): Promise<DaemonDispatchResult> {
  if (daemonUnavailable()) return { kind: "unavailable" }
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? daemonClientTimeoutMs(canonicalEvent)
  )
  try {
    const response = await (options.fetch ?? fetch)(
      `http://127.0.0.1:${daemonPort()}/dispatch?event=${encodeURIComponent(canonicalEvent)}&hookEventName=${encodeURIComponent(hookEventName)}`,
      {
        method: "POST",
        body: payloadStr,
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
      }
    )
    if (!response.ok) {
      lastDaemonFailureAt = Date.now()
      return { kind: response.status === 504 ? "timeout" : "unavailable" }
    }
    // Keep the deadline active while reading the response body as well as its headers.
    const value: unknown = await response.json()
    return {
      kind: "response",
      response: normalizeDaemonResponse(value),
    }
  } catch {
    lastDaemonFailureAt = Date.now()
    return { kind: controller.signal.aborted ? "timeout" : "unavailable" }
  } finally {
    clearTimeout(timer)
  }
}

const ENV_PATTERNS = [
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

export function enrichDispatchPayload(
  payload: Record<string, any>,
  agentId?: string,
  processStartedAt?: number
): void {
  if (!payload._terminal) {
    const terminal = detectTerminal()
    payload._terminal = { app: terminal.app, name: terminal.name }
  }
  if (!payload._env) {
    payload._env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => value !== undefined && ENV_PATTERNS.some((pattern) => pattern.test(key))
      )
    )
  }
  if (agentId && !payload._agent) payload._agent = agentId
  if (processStartedAt !== undefined) {
    payload._swizTiming = { cliBootstrapMs: Math.max(0, performance.now() - processStartedAt) }
  }
}
