/**
 * Generic text humanisation utility.
 * Rewrites terse, machine-generated notes or logs into short, natural paragraphs.
 */

import { createHash } from "node:crypto"
import { mkdir, readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { LRUCache } from "lru-cache"
import { promptText } from "../ai-providers.ts"
import { getHomeDirWithFallback } from "../home.ts"

const HUMANISE_CACHE = new LRUCache<string, Promise<string>>({
  max: 250,
  ttl: 10 * 60 * 1000,
})

/**
 * Directory holding the persistent on-disk humanise prompt cache.
 * Honours `SWIZ_PROMPT_CACHE_DIR` as an override (used by tests and to relocate
 * the cache); otherwise defaults to `~/.swiz/prompt-cache`.
 */
function promptCacheDir(): string {
  const override = process.env.SWIZ_PROMPT_CACHE_DIR
  if (override) return override
  return join(getHomeDirWithFallback("/tmp"), ".swiz", "prompt-cache")
}

/**
 * Resolve the on-disk cache file for a given prompt string. The file name is a
 * SHA-256 hex digest of the full prompt so identical prompts share an entry.
 * `dir` is injectable (defaults to {@link promptCacheDir}) so callers and tests
 * can target an isolated directory without mutating process-wide env.
 */
export function promptCachePath(prompt: string, dir: string = promptCacheDir()): string {
  const hash = createHash("sha256").update(prompt).digest("hex")
  return join(dir, `${hash}.txt`)
}

/** Read a previously cached humanisation from disk, or null on miss/error. */
export async function readPromptDiskCache(
  prompt: string,
  dir: string = promptCacheDir()
): Promise<string | null> {
  try {
    const file = Bun.file(promptCachePath(prompt, dir))
    if (!(await file.exists())) return null
    const text = await file.text()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

/** Maximum number of cached prompt files retained on disk before eviction. */
export const PROMPT_CACHE_MAX_ENTRIES = 500
/** Entries older than this (by mtime) are pruned on the next write. */
export const PROMPT_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Best-effort bound on the on-disk cache, mirroring the in-memory LRU's
 * eviction. Removes entries older than {@link PROMPT_CACHE_MAX_AGE_MS}, then
 * trims the oldest remaining files until at most {@link PROMPT_CACHE_MAX_ENTRIES}
 * remain. All errors are swallowed — pruning must never break humanisation.
 */
export async function prunePromptDiskCache(dir: string = promptCacheDir()): Promise<void> {
  try {
    const names = (await readdir(dir)).filter((name) => name.endsWith(".txt"))
    const now = Date.now()
    const entries: Array<{ path: string; mtimeMs: number }> = []
    for (const name of names) {
      const path = join(dir, name)
      try {
        const info = await stat(path)
        if (now - info.mtimeMs > PROMPT_CACHE_MAX_AGE_MS) {
          await rm(path, { force: true })
          continue
        }
        entries.push({ path, mtimeMs: info.mtimeMs })
      } catch {
        // Skip files that vanish or fail to stat between readdir and stat.
      }
    }
    if (entries.length <= PROMPT_CACHE_MAX_ENTRIES) return
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
    const overflow = entries.slice(0, entries.length - PROMPT_CACHE_MAX_ENTRIES)
    for (const { path } of overflow) {
      await rm(path, { force: true }).catch(() => {})
    }
  } catch {
    // Directory missing or unreadable; nothing to prune.
  }
}

/** Persist a humanisation to disk (best-effort; write errors are ignored). */
export async function writePromptDiskCache(
  prompt: string,
  value: string,
  dir: string = promptCacheDir()
): Promise<void> {
  try {
    await mkdir(dir, { recursive: true })
    await Bun.write(promptCachePath(prompt, dir), value)
    await prunePromptDiskCache(dir)
  } catch {
    // Disk cache is best-effort; a failed write must not break humanisation.
  }
}

export const DEFAULT_HUMANISE_TIMEOUT_MS = 8_000

export const DEFAULT_HUMANISE_SYSTEM_PROMPT = [
  "You rewrite terse, machine-generated coding-agent steering notes into a single paragraph of clear, polite, and direct instruction.",
  "Use good manners throughout: praise what has already been done well before raising what still needs attention, use 'please' when making requests, and close with 'thanks' or 'thank you' where natural.",
  "Frame outstanding work in an astute but direct manner, pointing out what has not been done yet and what needs to happen (for example, 'I noticed you haven't [action/state] yet — please [next steps], thanks').",
  "Use unambiguous, plain language with no flowery terms, motivational phrasing, executive-speak, or vague qualifiers.",
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
  if (
    /^(?:please|i need you to|can you|could you|when you|let's|thanks|thank you)\b/i.test(
      instruction
    )
  ) {
    return sentenceCase(instruction)
  }
  const prefix = options?.prefix ?? "I noticed you haven't done this yet — please "
  return sentenceCase(`${prefix}${instruction}, thanks`)
}

export interface HumaniseOptions {
  systemPrompt?: string
  timeoutMs?: number
  fallback?: (text: string) => string
  stripLine?: (line: string) => string
  /** Override the on-disk cache directory (defaults to ~/.swiz/prompt-cache). */
  cacheDir?: string
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

  const systemPrompt = options?.systemPrompt ?? DEFAULT_HUMANISE_SYSTEM_PROMPT
  const timeout = options?.timeoutMs ?? DEFAULT_HUMANISE_TIMEOUT_MS
  const stripLine = options?.stripLine
  const prompt = `${systemPrompt}\n\nText to rewrite:\n${trimmed}`
  const cacheDir = options?.cacheDir

  const diskCached = await readPromptDiskCache(prompt, cacheDir)
  if (diskCached) return diskCached

  try {
    const rewrittenRaw = await promptText(prompt, { provider: "openrouter", timeout })
    const rewritten = toSingleParagraph(rewrittenRaw, stripLine)

    if (!rewritten || rewritten === toSingleParagraph(trimmed, stripLine)) {
      return fallback
    }
    await writePromptDiskCache(prompt, rewritten, cacheDir)
    return rewritten
  } catch {
    return fallback
  }
}

export function clearHumaniseCache(): void {
  HUMANISE_CACHE.clear()
}
