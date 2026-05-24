/**
 * Generic text humanisation utility.
 * Rewrites terse, machine-generated notes or logs into short, natural paragraphs.
 */

import { LRUCache } from "lru-cache"
import { promptText } from "../ai-providers.ts"

const HUMANISE_CACHE = new LRUCache<string, Promise<string>>({
  max: 250,
  ttl: 10 * 60 * 1000,
})

export const DEFAULT_HUMANISE_TIMEOUT_MS = 8_000

export const DEFAULT_HUMANISE_SYSTEM_PROMPT = [
  "You rewrite terse, machine-generated coding-agent steering notes into a single paragraph of clear, authoritative executive direction.",
  "Encourage active forward progress and decisive action using a direct, collaborative, and professional human voice.",
  "Start directly with the core action needed to deliver the outcome, avoiding conversational filler, tentative framing, or robotic preambles.",
  "Preserve every concrete command, file path, instruction, and constraint exactly.",
  "Do not add any new instructions, commentary, headings, bullet points, quotes, or formatting.",
  "Return only the rewritten paragraph.",
].join(" ")

const LEADING_MARKER_RE = /^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+|[a-z][.)]\s+|\[[ x]\]\s+)/i

const KNOWN_IMPERATIVE_RE =
  /^(Continue|Take|Fix|Add|Update|Commit|Push|Run|Resolve|Use|Complete|Create|Check|Inspect|Read|Review|Re-run|Rerun|Open|Follow|Handle|Address)\b/

export function lowerKnownImperative(text: string): string {
  return text.replace(KNOWN_IMPERATIVE_RE, (verb) => verb.toLowerCase())
}

export function sentenceCase(text: string): string {
  if (!text) return text
  return /[.!?]$/.test(text) ? text : `${text}.`
}

/**
 * Normalizes and converts multi-line text into a single space-separated paragraph.
 * Optionally applies a custom line stripper callback.
 */
export function toSingleParagraph(text: string, stripLine?: (line: string) => string): string {
  return text
    .split(/\r?\n+/)
    .map((line) => {
      if (stripLine) {
        return stripLine(line)
      }
      let cleaned = line.normalize("NFKC").trim()
      if (!cleaned) return ""
      cleaned = cleaned.replace(LEADING_MARKER_RE, "").trim()
      return cleaned.replace(/\s+/g, " ")
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Fallback humanisation when the AI provider is unavailable.
 */
export function fallbackHumaniseText(
  text: string,
  options?: {
    prefix?: string
    stripLine?: (line: string) => string
  }
): string {
  const paragraph = toSingleParagraph(text, options?.stripLine)
  if (!paragraph) return text
  const instruction = lowerKnownImperative(paragraph)
  if (/^(?:please|i need you to|can you|could you|when you|let's)\b/i.test(instruction)) {
    return sentenceCase(instruction)
  }
  const prefix = options?.prefix ?? "Please "
  return sentenceCase(`${prefix}${instruction}`)
}

export interface HumaniseOptions {
  systemPrompt?: string
  timeoutMs?: number
  fallback?: (text: string) => string
  stripLine?: (line: string) => string
}

/**
 * Rewrites a message into a humanised, single paragraph via the AI provider layer.
 */
export async function humaniseText(message: string, options?: HumaniseOptions): Promise<string> {
  const trimmed = message.trim()
  if (!trimmed) return message

  // Include the system prompt in the cache key to prevent collision if different prompts are used
  const cacheKey = `${trimmed}::${options?.systemPrompt ?? ""}`
  const cached = HUMANISE_CACHE.get(cacheKey)
  if (cached) return cached

  const promise = humaniseTextUncached(trimmed, options)
  HUMANISE_CACHE.set(cacheKey, promise)
  return promise
}

function getFallback(trimmed: string, options?: HumaniseOptions): string {
  if (options?.fallback) return options.fallback(trimmed)
  return fallbackHumaniseText(trimmed, { stripLine: options?.stripLine })
}

async function humaniseTextUncached(trimmed: string, options?: HumaniseOptions): Promise<string> {
  const fallback = getFallback(trimmed, options)

  try {
    const systemPrompt = options?.systemPrompt ?? DEFAULT_HUMANISE_SYSTEM_PROMPT
    const timeout = options?.timeoutMs ?? DEFAULT_HUMANISE_TIMEOUT_MS
    const stripLine = options?.stripLine

    const prompt = `${systemPrompt}\n\nText to rewrite:\n${trimmed}`
    const rewrittenRaw = await promptText(prompt, { provider: "openrouter", timeout })
    const rewritten = toSingleParagraph(rewrittenRaw, stripLine)

    if (!rewritten || rewritten === toSingleParagraph(trimmed, stripLine)) {
      return fallback
    }
    return rewritten
  } catch {
    return fallback
  }
}

export function clearHumaniseCache(): void {
  HUMANISE_CACHE.clear()
}
