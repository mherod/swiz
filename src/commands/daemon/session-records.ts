import { isHookFeedback, type TranscriptEntry } from "../../transcript-utils.ts"
import { splitJsonlLines, tryParseJsonLine } from "../../utils/jsonl.ts"
import { extractMessageText, extractToolCalls, type SessionMessage } from "./utils.ts"

export const MAX_TRANSCRIPT_ENTRIES = 2000

/** Keep display data, never the original tool output or provider envelope. */
export interface PreparedSessionEntry {
  position: number
  timestamp?: string
  message: SessionMessage | null
}

export function prepareSessionEntry(
  entry: TranscriptEntry,
  position: number
): PreparedSessionEntry {
  const prepared: PreparedSessionEntry = { position, timestamp: entry.timestamp, message: null }
  if (entry.type !== "user" && entry.type !== "assistant") return prepared
  const content = entry.message?.content
  if (entry.type === "user" && isHookFeedback(content)) return prepared
  const text = extractMessageText(content)
  const toolCalls = extractToolCalls(content)
  if (!text && toolCalls.length === 0) return prepared
  prepared.message = {
    role: entry.type,
    timestamp: entry.timestamp ?? null,
    text,
    ...(toolCalls.length ? { toolCalls } : {}),
  }
  return prepared
}

export function messageRetainedChars(message: SessionMessage): number {
  let chars = message.text.length + (message.timestamp?.length ?? 0)
  for (const call of message.toolCalls ?? []) chars += call.name.length + call.detail.length
  return chars
}

export interface SessionTokenStats {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  /** Rate between the first and last usage samples in the bounded preview window. */
  outputTokensPerMinute: number
}

export interface SessionTokenSample {
  position: number
  at: number
  stats: SessionTokenStats
}

function tokenCount(value: unknown): number {
  return typeof value === "number" ? value : 0
}

/** Tolerate malformed provider telemetry exactly as the cold reader does. */
export function readTokenSample(value: unknown, position: number): SessionTokenSample | undefined {
  const record = value as Record<string, any> | undefined
  const usage =
    record?.payload?.type === "token_count" ? record.payload.info?.total_token_usage : null
  const totalTokens = usage?.total_tokens
  if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens)) return undefined
  return {
    position,
    at: typeof record?.timestamp === "string" ? new Date(record.timestamp).getTime() : 0,
    stats: {
      totalTokens,
      inputTokens: tokenCount(usage.input_tokens),
      outputTokens: tokenCount(usage.output_tokens),
      cachedInputTokens: tokenCount(usage.cached_input_tokens),
      outputTokensPerMinute: 0,
    },
  }
}

export function summarizeTokenSamples(
  first: SessionTokenSample | undefined,
  latest: SessionTokenSample | undefined,
  latestAt: number
): SessionTokenStats | undefined {
  if (!first || !latest) return undefined
  const firstAt = Number.isFinite(first.at) ? first.at : 0
  const elapsedMinutes = Math.max((latestAt - firstAt) / 60_000, 0)
  return {
    ...latest.stats,
    outputTokensPerMinute:
      elapsedMinutes > 0
        ? Math.round((latest.stats.outputTokens - first.stats.outputTokens) / elapsedMinutes)
        : 0,
  }
}

export function readTokenStats(text: string): SessionTokenStats | undefined {
  let first: SessionTokenSample | undefined
  let latest: SessionTokenSample | undefined
  let latestAt = 0
  for (const line of splitJsonlLines(text)) {
    const sample = readTokenSample(tryParseJsonLine(line), 0)
    if (!sample) continue
    first ??= sample
    latest = sample
    if (Number.isFinite(sample.at)) latestAt = sample.at
  }
  return summarizeTokenSamples(first, latest, latestAt)
}
