import { stat } from "node:fs/promises"

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

const TOOL_CONTEXT_EVENTS = new Set(["preToolUse", "postToolUse", "postToolUseFailure"])

interface SessionAgeOptions {
  nowMs?: number
  transcriptStartedAtMs?: number | null
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function finiteTimestamp(value: unknown, nowMs: number): number | null {
  const timestamp =
    typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= nowMs ? timestamp : null
}

function firstUsageTimestamp(payload: Record<string, any>, nowMs: number): number | null {
  const usage = payload._currentSessionToolUsage
  if (!isRecord(usage) || !Array.isArray(usage.events)) return null

  let first: number | null = null
  for (const event of usage.events) {
    if (!isRecord(event)) continue
    const timestamp = finiteTimestamp(event.timestamp, nowMs)
    if (timestamp !== null && (first === null || timestamp < first)) first = timestamp
  }
  return first
}

function summaryElapsedMs(payload: Record<string, any>): number | null {
  const summary = payload._transcriptSummary
  if (!isRecord(summary)) return null
  const elapsedMs = summary.sessionDurationMs
  return typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs >= 0
    ? elapsedMs
    : null
}

function resolveSessionElapsedMs(
  payload: Record<string, any>,
  nowMs: number,
  transcriptStartedAtMs: number | null
): number | null {
  const summary = isRecord(payload._transcriptSummary) ? payload._transcriptSummary : null
  const startCandidates = [
    finiteTimestamp(transcriptStartedAtMs, nowMs),
    finiteTimestamp(summary?.firstTimestamp, nowMs),
    firstUsageTimestamp(payload, nowMs),
  ].filter((value): value is number => value !== null)

  if (startCandidates.length > 0) return nowMs - Math.min(...startCandidates)
  return summaryElapsedMs(payload)
}

function appendParagraph(existing: string, paragraph: string): string {
  const text = existing.trim()
  if (!text) return paragraph
  if (text.includes(paragraph)) return text
  return `${text}\n\n${paragraph}`
}

function existingToolContext(
  response: Record<string, any>
): { hookSpecificOutput: Record<string, any>; additionalContext: string } | null {
  const hookSpecificOutput = response.hookSpecificOutput
  if (!isRecord(hookSpecificOutput)) return null
  const additionalContext = hookSpecificOutput.additionalContext
  if (typeof additionalContext !== "string" || !additionalContext.trim()) return null
  return { hookSpecificOutput, additionalContext }
}

function appendSystemMessagePhase(response: Record<string, any>, ageContext: string): void {
  const systemMessage = response.systemMessage
  if (typeof systemMessage !== "string" || !systemMessage.trim()) return
  response.systemMessage = appendParagraph(systemMessage, ageContext)
}

/**
 * Translate elapsed session time into deliberately broad phases. The ranges
 * give agents temporal orientation without exposing a precise stopwatch.
 */
export function formatCoarseSessionAge(elapsedMs: number): string | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null
  if (elapsedMs < 15 * MINUTE_MS) {
    return "Session phase: opening (under about 15 minutes active)."
  }
  if (elapsedMs < 45 * MINUTE_MS) {
    return "Session phase: underway (about 15-45 minutes active)."
  }
  if (elapsedMs < 90 * MINUTE_MS) {
    return "Session phase: established (about 45-90 minutes active)."
  }
  if (elapsedMs < 3 * HOUR_MS) {
    return "Session phase: extended (about 1.5-3 hours active)."
  }
  return "Session phase: long-running (over about 3 hours active)."
}

/** Decorate existing tool-event context in place; never creates standalone noise. */
export function injectCoarseSessionAgeContext(
  response: Record<string, any>,
  canonicalEvent: string,
  payload: Record<string, any>,
  options: SessionAgeOptions = {}
): void {
  if (!TOOL_CONTEXT_EVENTS.has(canonicalEvent)) return
  const context = existingToolContext(response)
  if (!context) return

  const nowMs = options.nowMs ?? Date.now()
  const elapsedMs = resolveSessionElapsedMs(payload, nowMs, options.transcriptStartedAtMs ?? null)
  if (elapsedMs === null) return

  const ageContext = formatCoarseSessionAge(elapsedMs)
  if (!ageContext) return
  context.hookSpecificOutput.additionalContext = appendParagraph(
    context.additionalContext,
    ageContext
  )
  appendSystemMessagePhase(response, ageContext)
}

async function transcriptStartedAtMs(payload: Record<string, any>): Promise<number | null> {
  const transcriptPath = payload.transcript_path
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) return null
  try {
    const metadata = await stat(transcriptPath)
    return Number.isFinite(metadata.birthtimeMs) && metadata.birthtimeMs > 0
      ? metadata.birthtimeMs
      : null
  } catch {
    return null
  }
}

/** Parse the dispatch payload, resolve transcript age, and fail open on malformed input. */
export async function injectDispatchSessionAgeContext(
  response: Record<string, any>,
  canonicalEvent: string,
  enrichedPayloadStr: string
): Promise<void> {
  if (!TOOL_CONTEXT_EVENTS.has(canonicalEvent)) return
  try {
    const payload = JSON.parse(enrichedPayloadStr) as Record<string, any>
    injectCoarseSessionAgeContext(response, canonicalEvent, payload, {
      transcriptStartedAtMs: await transcriptStartedAtMs(payload),
    })
  } catch {
    // Context decoration is advisory; malformed payloads and file errors fail open.
  }
}
