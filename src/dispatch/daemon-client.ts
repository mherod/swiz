/** Lightweight transport shared by both CLI entry points; no manifest or engine imports. */
import { swizDaemonCircuitPath } from "../temp-paths.ts"
import { detectTerminal } from "../utils/terminal-detection.ts"
import { dispatchTimeoutSeconds } from "./timeouts.ts"

const BACKOFF_MS = 30_000
let lastDaemonFailureAt = 0

/**
 * How long every dispatch client skips a daemon that failed to answer in time.
 * Each hook call is a fresh process, so without a shared marker every call
 * would wait out the same hang; with it, one call pays and the rest pass
 * straight through until a single probe finds the daemon healthy again.
 */
export const DAEMON_CIRCUIT_OPEN_MS = 30_000

export function resetDaemonBackoff(): void {
  lastDaemonFailureAt = 0
}

/** Stop retains its local checks on transport timeout; other hooks avoid a second execution. */
export function daemonDispatchPolicy(canonicalEvent: string): {
  timeoutMs: number
  timeoutFallback: "local" | "allow"
} {
  const budgetMs = dispatchTimeoutSeconds(canonicalEvent) * 1000
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
  /** `skipped`: the breaker was open, so the daemon was not contacted at all. */
  | { kind: "timeout"; skipped?: boolean }

export interface DaemonDispatchOptions {
  timeoutMs?: number
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  /**
   * Breaker marker file. Defaults to the shared per-port marker; `null` disables
   * the breaker. An injected `fetch` is not the shared daemon, so it only uses a
   * breaker when a path is given explicitly.
   */
  circuitPath?: string | null
}

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

// ─── Cross-process circuit breaker ─────────────────────────────────────────

function resolveCircuitPath(options: DaemonDispatchOptions): string | null {
  if (options.circuitPath !== undefined) return options.circuitPath
  if (options.fetch || process.env.SWIZ_DAEMON_CIRCUIT === "0") return null
  return swizDaemonCircuitPath(daemonPort())
}

async function readCircuitOpenedAt(path: string): Promise<number> {
  try {
    const openedAt = Number.parseInt(await Bun.file(path).text(), 10)
    return Number.isFinite(openedAt) && openedAt > 0 ? openedAt : 0
  } catch {
    // No marker: the breaker has never tripped.
    return 0
  }
}

async function writeCircuit(path: string, openedAt: number): Promise<void> {
  try {
    await Bun.write(path, String(openedAt))
  } catch {
    // The breaker is an optimisation; without it every dispatch simply probes.
  }
}

/**
 * `open`: skip the daemon. `probing`: the window elapsed and this dispatch is
 * the one that tests the daemon; the marker is re-armed first so concurrent
 * dispatches keep skipping instead of all probing a daemon that is still hung.
 */
async function enterCircuit(path: string): Promise<"closed" | "open" | "probing"> {
  const now = Date.now()
  const openedAt = await readCircuitOpenedAt(path)
  // A marker from the future (clock change) must not hold the breaker open.
  if (openedAt === 0 || openedAt > now) return "closed"
  if (now - openedAt < DAEMON_CIRCUIT_OPEN_MS) return "open"
  await writeCircuit(path, now)
  return "probing"
}

async function settleCircuit(
  path: string,
  probing: boolean,
  kind: DaemonDispatchResult["kind"]
): Promise<void> {
  if (kind === "timeout") await writeCircuit(path, Date.now())
  else if (probing) await writeCircuit(path, 0)
}

async function requestDaemonDispatch(
  canonicalEvent: string,
  hookEventName: string,
  payloadStr: string,
  options: DaemonDispatchOptions
): Promise<DaemonDispatchResult> {
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

export async function tryDaemonDispatch(
  canonicalEvent: string,
  hookEventName: string,
  payloadStr: string,
  options: DaemonDispatchOptions = {}
): Promise<DaemonDispatchResult> {
  if (daemonUnavailable()) return { kind: "unavailable" }
  const circuitPath = resolveCircuitPath(options)
  const circuit = circuitPath ? await enterCircuit(circuitPath) : "closed"
  if (circuit === "open") return { kind: "timeout", skipped: true }
  const result = await requestDaemonDispatch(canonicalEvent, hookEventName, payloadStr, options)
  if (circuitPath) await settleCircuit(circuitPath, circuit === "probing", result.kind)
  return result
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
