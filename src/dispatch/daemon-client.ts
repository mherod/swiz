/** Lightweight transport shared by both CLI entry points; no manifest or engine imports. */
import { swizDaemonCircuitPath } from "../temp-paths.ts"
import { detectTerminal } from "../utils/terminal-detection.ts"
import { GIT_HOOK_EVENTS } from "./git-hook-events.ts"
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

/**
 * Timeouts in a row, with no answer between them, before the breaker opens.
 * An open breaker lets every session's tool hooks through unchecked, so one
 * slow dispatch on a busy machine must not open it; a hung daemon produces
 * the second timeout within one client deadline.
 */
export const DAEMON_CIRCUIT_TRIP_THRESHOLD = 2

export function resetDaemonBackoff(): void {
  lastDaemonFailureAt = 0
}

/**
 * Stop and git hooks keep their checks on a transport timeout by running
 * locally: a stop decision and the commit and push floor must not be skipped
 * because the daemon was slow. Agent tool hooks are allowed instead, which
 * avoids a second execution inside the agent's own hook deadline.
 */
export function daemonDispatchPolicy(canonicalEvent: string): {
  timeoutMs: number
  timeoutFallback: "local" | "allow"
} {
  const budgetMs = dispatchTimeoutSeconds(canonicalEvent) * 1000
  const keepsChecks =
    canonicalEvent === "stop" ||
    canonicalEvent === "subagentStop" ||
    GIT_HOOK_EVENTS.has(canonicalEvent)
  return {
    timeoutMs: Math.max(1000, budgetMs - 3000),
    timeoutFallback: keepsChecks ? "local" : "allow",
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

export interface DaemonCircuitState {
  /** When the breaker opened or was last re-armed; 0 while closed. */
  openedAt: number
  /** Timeouts in a row since the daemon last answered. */
  consecutiveTimeouts: number
  /** Times the breaker has opened. */
  trips: number
  /** When it last opened. */
  lastTripAt: number
  /** Total time it has spent open, during which tool hooks ran unchecked. */
  openMsTotal: number
}

const CLOSED_CIRCUIT: DaemonCircuitState = {
  openedAt: 0,
  consecutiveTimeouts: 0,
  trips: 0,
  lastTripAt: 0,
  openMsTotal: 0,
}

function positive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/** Read the marker. A bare timestamp, the earlier format, is still understood. */
export async function readDaemonCircuitState(path: string): Promise<DaemonCircuitState> {
  try {
    const raw: unknown = JSON.parse(await Bun.file(path).text())
    if (typeof raw === "number") return { ...CLOSED_CIRCUIT, openedAt: positive(raw) }
    const record = (raw ?? {}) as Record<string, unknown>
    return {
      openedAt: positive(record.openedAt),
      consecutiveTimeouts: positive(record.consecutiveTimeouts),
      trips: positive(record.trips),
      lastTripAt: positive(record.lastTripAt),
      openMsTotal: positive(record.openMsTotal),
    }
  } catch {
    // No marker: the breaker has never tripped.
    return { ...CLOSED_CIRCUIT }
  }
}

/** Breaker state for the daemon this process would dispatch to. */
export async function readSharedDaemonCircuitState(): Promise<DaemonCircuitState> {
  return await readDaemonCircuitState(swizDaemonCircuitPath(daemonPort()))
}

async function writeCircuit(path: string, state: DaemonCircuitState): Promise<void> {
  try {
    await Bun.write(path, JSON.stringify(state))
  } catch {
    // The breaker is an optimisation; without it every dispatch simply probes.
  }
}

type CircuitMode = "closed" | "open" | "probing"

interface CircuitEntry {
  mode: CircuitMode
  /** True when a healthy answer has something to clear. */
  dirty: boolean
}

/**
 * `open`: skip the daemon. `probing`: the window elapsed and this dispatch is
 * the one that tests the daemon; the marker is re-armed first so concurrent
 * dispatches keep skipping instead of all probing a daemon that is still hung.
 */
async function enterCircuit(path: string): Promise<CircuitEntry> {
  const now = Date.now()
  const state = await readDaemonCircuitState(path)
  // A marker from the future (clock change) must not hold the breaker open.
  if (state.openedAt === 0 || state.openedAt > now) {
    return { mode: "closed", dirty: state.consecutiveTimeouts > 0 || state.openedAt > 0 }
  }
  if (now - state.openedAt < DAEMON_CIRCUIT_OPEN_MS) return { mode: "open", dirty: true }
  await writeCircuit(path, { ...state, openedAt: now })
  return { mode: "probing", dirty: true }
}

function afterTimeout(state: DaemonCircuitState, mode: CircuitMode): DaemonCircuitState {
  const now = Date.now()
  const consecutiveTimeouts = state.consecutiveTimeouts + 1
  // A failed probe keeps the breaker open for another whole window.
  if (mode === "probing") return { ...state, openedAt: now, consecutiveTimeouts }
  const alreadyOpen = state.openedAt > 0 && state.openedAt <= now
  if (alreadyOpen || consecutiveTimeouts < DAEMON_CIRCUIT_TRIP_THRESHOLD) {
    return { ...state, consecutiveTimeouts }
  }
  return { ...state, openedAt: now, consecutiveTimeouts, trips: state.trips + 1, lastTripAt: now }
}

function afterAnswer(state: DaemonCircuitState): DaemonCircuitState {
  const wasOpen = state.openedAt > 0 && state.lastTripAt > 0
  const openMs = wasOpen ? Math.max(0, Date.now() - state.lastTripAt) : 0
  return {
    ...state,
    openedAt: 0,
    consecutiveTimeouts: 0,
    openMsTotal: state.openMsTotal + openMs,
  }
}

async function settleCircuit(
  path: string,
  entry: CircuitEntry,
  kind: DaemonDispatchResult["kind"]
): Promise<void> {
  // The common case, a healthy answer with nothing recorded, costs no write.
  if (kind !== "timeout" && !entry.dirty) return
  // Re-read so concurrent dispatches add to each other's counts.
  const state = await readDaemonCircuitState(path)
  await writeCircuit(
    path,
    kind === "timeout" ? afterTimeout(state, entry.mode) : afterAnswer(state)
  )
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
  const entry = circuitPath ? await enterCircuit(circuitPath) : null
  if (entry?.mode === "open") return { kind: "timeout", skipped: true }
  const result = await requestDaemonDispatch(canonicalEvent, hookEventName, payloadStr, options)
  if (circuitPath && entry) await settleCircuit(circuitPath, entry, result.kind)
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
