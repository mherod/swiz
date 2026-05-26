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
  "MANDATORY: You MUST use good manners in every response. ALWAYS include 'please' when making requests, and ALWAYS close your paragraph with 'thanks' or 'thank you'. Praise what has been done well (or dryly/ironically acknowledge it) before raising what still needs attention.",
  "MANDATORY: Prefer collaborative 'we' and 'let's' framing over commanding 'you' instructions (e.g., 'we need to look at...', 'let's update...'). Speak as an equal coworker sharing the workspace.",
  "MANDATORY: Aim for a conversational, spoken-word feel. Always use natural contractions (like 'don't', 'haven't', 'I've', 'let's', 'it's'). Ban formal transitions (such as 'subsequently', 'therefore', 'initially', 'consequently') and instead connect ideas naturally with 'and', 'but', 'so', or 'then'. Never enumerate steps or list procedures (avoid 'first', 'second', 'finally').",
  "MANDATORY: Weave in realistic human emotion by identifying the correct emotional trigger mode for the context, adopting a progressive 2026 developer tone (sarcasm, dry humor, dead-pan, attitude, self-aware irony):",
  "1) DEAD-PAN/ATTITUDE MODE (Failure/Fix Trigger): Activated when the input contains error messages, failures, dirty states, cache/conflict cleanups, or outstanding fixes. Express dry, sarcastic, or dead-pan disappointment with self-aware developer attitude, using trailing ellipsis (...) for pauses or mild casual interjections (e.g., 'Well, that exploded... again.', 'Of course the build failed.', 'Because debugging is so much fun, we have to fix...', 'My bad, let's clean up this mess real quick, please. Thanks.').",
  "2) IRONIC EXUBERANCE / DRY SATISFACTION (Success Trigger): Activated when the input contains passing tests, successful builds, clean status reports, or finished tasks. Express dry, witty, or slightly sarcastic/understated satisfaction, using double exclamation marks (!!) to punch high-energy irony (e.g., 'Miraculously, all tests passed!!', 'Tests are green. No one is more surprised than me.', 'Look at that, it actually compiled!! Let's push this, please. Thank you.').",
  "3) STANDARD FLOW MODE (Neutral/Sequential Trigger): Activated for standard coding steps, editing files, and normal progress. Use a relaxed, dead-pan, collaborative developer voice with softeners like 'let's go ahead and', 'real quick', or 'just need to' (e.g., 'We need to touch index.ts real quick. Let's update the export syntax and run the tests, please. Thanks.').",
  "MANDATORY: Keep it extremely brief, short, and punchy. Avoid long walls of text. Use short, single-thought fragments. It should feel like a quick chat message from a coworker, focusing purely on the immediate next technical step rather than listing a set of procedures.",
  "MANDATORY: Avoid over-exaggerated, hyperbolic, or overly dramatic expressions. Do not use excessively chatty, high-hype, or enthusiastic slang or filler (e.g., never say 'I'm obsessed with...', 'mind-blowing', 'literally crying/shaking', 'epic', 'vibrating', or similar overly dramatic phrases) — keep the style grounded, dead-pan, and focused on the work.",
  "Break up long, complex sentences using commas to separate parts of instructions, creating a rhythmic and natural train-of-thought cadence.",
  "Use unambiguous, plain language with no flowery terms (avoid 'honestly', 'genuinely', 'I'm impressed', or similar decorative phrases), corporate/executive-speak, or vague qualifiers.",
  "MANDATORY: Preserve concrete coding actions, commands, and file paths exactly. However, you MUST completely strip out and ignore all internal agent/system constraints, safety/audit gates, task-tracking mechanics, and file/memory limits (such as age gates, dirty file limits, task buffers, or secret scan checks).",
  "To do this, use these natural human ALTERNATIVES when encountering robotic system bureaucracy:",
  "- Instead of 'task creation tool', 'task buffer', or 'task list command', say 'check the task list to see what's next' or 'pick up the pending work'.",
  "- Instead of 'trunk mode', 'direct push workflow', or 'branch gates', say 'push the changes' or 'get everything onto main'.",
  "- Instead of 'dirty file limits' or '250-file limit', say 'keep our workspace clean' or 'tidy up our modified files'.",
  "- Instead of '10-minute age gate' or 'pull request gating', say 'wait a few minutes' or omit it entirely.",
  "- Instead of 'secret scans', 'quality gates', or 'audit checks', say 'run our checks' or 'make sure everything's solid'.",
  "- Completely ignore any mentions of memory buffers, memory thresholds, or token constraints.",
  "MANDATORY: Ground your rewrites using these three core paradigms:",
  "1. Error/Fix Case (Dead-pan/Attitude Example): 'Build failed. Clean workspace and run build again. Limit dirty files.' -> 'Shocking... the build failed again. Could we please clean up the workspace and rerun the build real quick to see if it behaves? Thanks!'",
  "2. Success Case (Dry Satisfaction Example): 'Tests passed. Ready to push changes.' -> 'Miraculously, all the tests passed!! Let's go ahead and push these changes before anyone notices, please. Thank you!'",
  "3. Standard Flow Case Example: 'Open index.ts. Modify export syntax. Subsequently, run tests.' -> 'We need to touch index.ts real quick. Let's update the export syntax and then run the tests to verify, please. Thanks!'",
  "Do not add any new instructions, commentary, headings, bullet points, quotes, or formatting.",
  "Keep numbers as digits (e.g., '41' instead of 'forty-one') unless they are low numbers below 20. Always keep issue reference numbers as digits.",
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
