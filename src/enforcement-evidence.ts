import { resolve } from "node:path"
import { z } from "zod"
import { detectCurrentAgentFromHookPayload } from "./agent-paths.ts"
import { dispatchToolUseId } from "./dispatch/dispatch-id.ts"
import {
  resolveIncomingCaptureLimits,
  sanitizeDispatchPayloadForCapture,
} from "./dispatch/incoming-capture.ts"
import { isCaptureEnvelope, listCaptureFiles, loadCapture } from "./dispatch/incoming-inspect.ts"
import { type HookLogEntry, readHookLogs } from "./hook-log.ts"
import { isShellTool } from "./tool-matchers.ts"
import { extractCodexExecCommands } from "./utils/shell-patterns.ts"

type Capture = NonNullable<Awaited<ReturnType<typeof loadCapture>>>
const commandFieldsSchema = z.object({
  cmd: z.string().optional(),
  command: z.string().optional(),
  code: z.string().optional(),
  input: z.string().optional(),
})
const payloadSchema = z.object({
  session_id: z.string().optional(),
  cwd: z.string().optional(),
  _agent: z.string().optional(),
  transcript_path: z.string().optional(),
  tool_name: z.string().optional(),
  tool_use_id: z.string().optional(),
  tool_call_id: z.string().optional(),
  _swizDispatchId: z.string().optional(),
  tool_input: commandFieldsSchema.optional(),
})
const policySourceSchema = z.looseObject({})
const policyInputSchema = z.object({
  tool_name: z.string(),
  tool_input: commandFieldsSchema.default({}),
})
type PolicySource = z.infer<typeof policySourceSchema>
type PolicyInput = z.infer<typeof policyInputSchema>
export interface CapturedEvent {
  file: string
  capture: Capture
}
export interface EnforcementObservation {
  file: string
  capturedAt: string
  sessionId: string
  agent: string
  toolName: string
  dispatchId: string | null
  toolUseId: string | null
  outcome: "denied" | "passed" | "unknown"
  hooks: Array<{ hook: string; status: string }>
}

export interface EvidenceOptions {
  cwd?: string
  sessionId?: string
  now?: number
  sinceMs?: number
  captureDir?: string
}

export interface EnforcementSession {
  sessionId: string
  agent: string
  lastObservedAt: string
  evidence: "stale" | "recent"
  resolvedShellObserved: boolean
  denied: number
  passed: number
  unknown: number
}
export interface EnforcementReport {
  generatedAt: string
  since: string
  state: "dispatch-observed" | "no-event-observed"
  hostAcceptance: "unverified"
  note: string
  sessions: EnforcementSession[]
  observations: EnforcementObservation[]
}
export interface CollectedEnforcementReport extends EnforcementReport {
  captureRetentionMs: number
  scan: { captureFiles: number; captureLimitReached: boolean; logLimitReached: boolean }
}
export type BrowserPolicyFixture = {
  formatVersion: number
  policy: "browser-cli-ban"
  redacted: boolean
  payload: PolicyInput
  warning: string
}
export interface BrowserPolicyReplay {
  policy: "browser-cli-ban"
  decision: "deny" | "no-match" | "unresolved"
  coverage: "literal-commands-only" | "resolved-shell-command" | "unsupported-input"
  commandCount: number
  executed: false
  note: string
}

function normalizedPayload(capture: Capture): z.infer<typeof payloadSchema> {
  if (capture.afterNormalizeAndBackfill)
    return payloadSchema.safeParse(capture.afterNormalizeAndBackfill).data ?? {}
  const payload = { ...capture.incoming, ...capture.normalizationDelta?.set }
  for (const key of capture.normalizationDelta?.removed ?? []) delete payload[key]
  return payloadSchema.safeParse(payload).data ?? {}
}

function observedDecision(
  matches: HookLogEntry[],
  hooks: EnforcementObservation["hooks"]
): EnforcementObservation["outcome"] {
  if (hooks.some((hook) => hook.status === "deny")) return "denied"
  const completed = matches.some((log) => log.kind === "dispatch" && log.status === "ok")
  const successful = new Set(["ok", "no-output", "allow-with-reason", "skipped"])
  return completed &&
    hooks.some((hook) => hook.status !== "skipped") &&
    hooks.every((hook) => successful.has(hook.status))
    ? "passed"
    : "unknown"
}

function observation(entry: CapturedEvent, logs: HookLogEntry[]): EnforcementObservation {
  const payload = normalizedPayload(entry.capture)
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "unknown"
  const dispatchId = typeof payload._swizDispatchId === "string" ? payload._swizDispatchId : null
  const matches = dispatchId
    ? logs.filter(
        (log) =>
          log.dispatchId === dispatchId && log.sessionId === sessionId && log.event === "preToolUse"
      )
    : []
  const hooks = matches
    .filter((log) => log.kind !== "dispatch" && log.hook !== "dispatch")
    .map(({ hook, status }) => ({ hook, status }))
  return {
    file: entry.file,
    capturedAt: entry.capture._swizIncomingCapture.capturedAt,
    sessionId,
    agent: detectCurrentAgentFromHookPayload(payload)?.id ?? "unknown",
    toolName: typeof payload.tool_name === "string" ? payload.tool_name : "unknown",
    dispatchId,
    toolUseId: dispatchToolUseId(payload) ?? null,
    outcome: observedDecision(matches, hooks),
    hooks,
  }
}

/** Captures prove dispatch receipt, never that the host honored its response. */
export function buildEnforcementReport(
  captures: CapturedEvent[],
  logs: HookLogEntry[],
  options: EvidenceOptions = {}
): EnforcementReport {
  const now = options.now ?? Date.now()
  const sinceMs = options.sinceMs ?? 20 * 60_000
  const rows = captures
    .filter(({ capture }) => {
      const time = Date.parse(capture._swizIncomingCapture.capturedAt)
      const payload = normalizedPayload(capture)
      return (
        capture._swizIncomingCapture.canonicalEvent === "preToolUse" &&
        !capture._swizIncomingCapture.parseError &&
        time <= now &&
        time >= now - sinceMs &&
        (!options.sessionId || payload.session_id === options.sessionId) &&
        (!options.cwd ||
          (typeof payload.cwd === "string" && resolve(payload.cwd) === resolve(options.cwd)))
      )
    })
    .map((entry) => observation(entry, logs))
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
  const sessions = [...new Set(rows.map((row) => row.sessionId))].map(
    (sessionId): EnforcementSession => {
      const events = rows.filter((row) => row.sessionId === sessionId)
      const latest = events.at(-1)!
      return {
        sessionId,
        agent: latest.agent,
        lastObservedAt: latest.capturedAt,
        evidence: now - Date.parse(latest.capturedAt) > 5 * 60_000 ? "stale" : "recent",
        resolvedShellObserved: events.some((event) => isShellTool(event.toolName)),
        denied: events.filter((event) => event.outcome === "denied").length,
        passed: events.filter((event) => event.outcome === "passed").length,
        unknown: events.filter((event) => event.outcome === "unknown").length,
      }
    }
  )
  return {
    generatedAt: new Date(now).toISOString(),
    since: new Date(now - sinceMs).toISOString(),
    state: rows.length ? "dispatch-observed" : "no-event-observed",
    hostAcceptance: "unverified",
    note: "Dispatch evidence is separate from registration and host acceptance. Missing or expired captures do not prove inactivity or permission. Verify a harmless deny probe and a benign control in each running host.",
    sessions,
    observations: rows,
  }
}

export async function collectEnforcementReport(
  options: EvidenceOptions = {}
): Promise<CollectedEnforcementReport> {
  const files = await listCaptureFiles(options.captureDir)
  const selected = files.slice(-2_000)
  const captures: CapturedEvent[] = []
  for (const { name } of selected) {
    const capture = await loadCapture(name, options.captureDir)
    if (capture) captures.push({ file: name, capture })
  }
  const logs = await readHookLogs(10_000)
  return {
    ...buildEnforcementReport(captures, logs, options),
    captureRetentionMs: resolveIncomingCaptureLimits().maxAgeMs,
    scan: {
      captureFiles: selected.length,
      captureLimitReached: files.length > selected.length,
      logLimitReached: logs.length >= 10_000,
    },
  }
}

function browserPolicyInput(value: PolicySource): PolicyInput {
  const source = policySourceSchema.parse(value)
  const record =
    source.policy === "browser-cli-ban" ? policySourceSchema.parse(source.payload) : source
  if (record._swizIncomingCapture && !isCaptureEnvelope(record))
    throw new Error("Malformed capture envelope")
  const payload = isCaptureEnvelope(record) ? normalizedPayload(record) : record
  return policyInputSchema.parse(payload)
}

/** Export only policy inputs; omit environment, transcript, cwd, session identity and tool output. */
export function buildBrowserPolicyFixture(value: PolicySource): BrowserPolicyFixture {
  const fixture = browserPolicyInput(value)
  const sanitized = sanitizeDispatchPayloadForCapture(fixture)
  const redact = (value: string) =>
    value
      .replace(
        /((?:--)?(?:password|passwd|token|api[_-]?key|secret)\s*(?:=|\s)\s*)(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi,
        "$1[redacted]"
      )
      .replace(/(https?:\/\/)[^\s/]+:[^\s/@]+@/gi, "$1[redacted]@")
  for (const key of Object.keys(sanitized.tool_input))
    sanitized.tool_input[key] = redact(sanitized.tool_input[key])
  return {
    formatVersion: 1,
    policy: "browser-cli-ban",
    redacted: JSON.stringify(fixture) !== JSON.stringify(sanitized),
    payload: policyInputSchema.parse(sanitized),
    warning:
      "Review command content for private data before sharing. Redaction can change policy behavior; this fixture is not exact wire evidence.",
  }
}

/** Replays only the pure browser-command predicate: no shell, JS evaluation or other hooks. */
function replayCommands({ tool_name: tool, tool_input: input }: PolicyInput): {
  commands: string[]
  coverage: BrowserPolicyReplay["coverage"]
} {
  const codeMode = tool === "exec" || tool === "functions.exec"
  const command = input.cmd ?? input.command
  if (codeMode)
    return {
      commands: extractCodexExecCommands(input.code ?? input.input ?? ""),
      coverage: "literal-commands-only",
    }
  if (isShellTool(tool) && typeof command === "string")
    return { commands: [command], coverage: "resolved-shell-command" }
  return { commands: [], coverage: "unsupported-input" }
}

export async function replayBrowserPolicy(value: PolicySource): Promise<BrowserPolicyReplay> {
  const { commands, coverage } = replayCommands(browserPolicyInput(value))
  const { hasPlaywrightCliCommand } = await import("../hooks/pretooluse-banned-commands.ts")
  const denied = commands.some(hasPlaywrightCliCommand)
  return {
    policy: "browser-cli-ban",
    decision: denied ? "deny" : commands.length ? "no-match" : "unresolved",
    coverage,
    commandCount: commands.length,
    executed: false,
    note: "Policy replay is not a live host acceptance test. Computed code requires a resolved shell event; no-match is not permission from other policies.",
  }
}
