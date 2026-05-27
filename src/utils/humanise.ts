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
import { extractTextFromUnknownContent } from "../transcript-extract.ts"
import { tryParseJsonLine } from "./jsonl.ts"
import { readSessionLines } from "./transcript.ts"

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

export const PROMPT_PART_GOAL_STEERING =
  "You rewrite terse, machine-generated coding-agent steering notes into a single paragraph of clear, polite, and direct instruction."

export const PROMPT_PART_GOAL_STRATEGY =
  "You rewrite a concatenated list of development environment warnings, status checks, and task lists into a single, cohesive paragraph of clear instruction, adopting a professional, direct, coworker-like developer tone (calm, focused, helpful, slightly dead-pan, without hyperactive sarcasm, extreme exaggeration, or emotional drama)."

export const PROMPT_PART_MANNERS =
  "MANDATORY: You MUST use good manners. ALWAYS include 'please' when making requests, and ALWAYS close your paragraph with 'thanks' or 'thank you'. Praise what has been done well (or dryly acknowledge it) before raising what still needs attention."

export const PROMPT_PART_MANNERS_DEFAULT =
  "MANDATORY: You MUST use good manners in every response. ALWAYS include 'please' when making requests, and ALWAYS close your paragraph with 'thanks' or 'thank you'. Praise what has been done well (or dryly acknowledge it) before raising what still needs attention."

export const PROMPT_PART_COLLABORATION =
  "MANDATORY: Prefer collaborative 'we' and 'let's' framing over commanding 'you' instructions (e.g., 'we need to look at...', 'let's update...'). Speak as an equal coworker sharing the workspace."

export const PROMPT_PART_CONVERSATIONAL_DEFAULT =
  "MANDATORY: Aim for a conversational, spoken-word feel. Always use natural contractions (like 'don't', 'haven't', 'I've', 'let's', 'it's'). Ban formal transitions (such as 'subsequently', 'therefore', 'initially', 'consequently') and instead connect ideas naturally with 'and', 'but', 'so', or 'then'. Never enumerate steps or list procedures (avoid 'first', 'second', 'finally')."

export const PROMPT_PART_CONVERSATIONAL_STRATEGY =
  "MANDATORY: Aim for a conversational, spoken-word feel. Always use natural contractions (like 'don't', 'haven't', 'I've', 'let's', 'it's'). Ban formal transitions (such as 'subsequently', 'therefore', 'initially', 'consequently') and instead connect ideas naturally with 'and', 'but', 'so', or 'then'. Never enumerate steps or list procedures."

export const PROMPT_PART_TONE_DEFAULT = [
  "MANDATORY: Weave in realistic human emotion by identifying the correct emotional trigger mode for the context, adopting a professional, direct, coworker-like developer tone (calm, focused, helpful, slightly dead-pan, without hyperactive sarcasm, extreme exaggeration, or emotional drama):",
  "1) DEAD-PAN/CALM MODE (Failure/Fix Trigger): Activated when the input contains error messages, failures, dirty states, cache/conflict cleanups, or outstanding fixes. Express dry, calm, or dead-pan focus on resolving the issue, using trailing ellipsis (...) for pauses or mild casual interjections (e.g., 'Well, the build failed... let's check it.', 'Looks like the tests didn't pass, let's fix it.', 'We have to resolve...', 'Let's clean up this mess real quick, please. Thanks.').",
  "2) SATISFACTION (Success Trigger): Activated when the input contains passing tests, successful builds, clean status reports, or finished tasks. Express calm, understated satisfaction (e.g., 'Nice, all the tests passed!! Let's push this, please. Thank you.').",
  "3) STANDARD FLOW MODE (Neutral/Sequential Trigger): Activated for standard coding steps, editing files, and normal progress. Use a relaxed, dead-pan, collaborative developer voice with softeners like 'let's go ahead and', 'real quick', or 'just need to' (e.g., 'We need to touch index.ts real quick. Let's update the export syntax and run the tests, please. Thanks.').",
].join(" ")

export const PROMPT_PART_TONE_STRATEGY =
  "MANDATORY: Weave in realistic human emotion by identifying the correct emotional trigger mode for the context (Dead-pan/Calm for errors/fixes/cleanups, Satisfaction for success/green status, Standard Flow for normal sequential progress)."

export const PROMPT_PART_BREVITY_DEFAULT =
  "MANDATORY: Keep it extremely brief, short, and punchy. Avoid long walls of text. Use short, single-thought fragments. It should feel like a quick chat message from a coworker, focusing purely on the immediate next technical step rather than listing a set of procedures."

export const PROMPT_PART_NO_DRAMA =
  "MANDATORY: Never use over-exaggerated, hyperbolic, or overly dramatic expressions. Absolutely ban and avoid all flowery, theatrical, or high-hype slang and dramatic filler (e.g., never say 'I'm obsessed with', 'honestly', 'genuinely', 'vibrating', 'mind-blowing', 'literally crying/shaking', 'epic', 'I'm impressed', 'pretty impressive', 'without the world ending', 'before the universe collapses', 'lose our minds', 'flatlining', or any references to world-ending/universe-collapsing events). Avoid sassy/sarcastic developer comments about boredom or headaches. Keep the style grounded, calm, and focused on the work."

export const PROMPT_PART_CADENCE_DEFAULT =
  "Break up long, complex sentences using commas to separate parts of instructions, creating a rhythmic and natural train-of-thought cadence."

export const PROMPT_PART_PLAIN_LANGUAGE =
  "Use unambiguous, plain language with no flowery terms, corporate/executive-speak, or vague qualifiers."

export const PROMPT_PART_STRIP_BUREAUCRACY_DEFAULT = [
  "MANDATORY: Preserve concrete coding actions, commands, and file paths exactly. However, you MUST completely strip out and ignore all internal agent/system constraints, safety/audit gates, task-tracking mechanics, and file/memory limits (such as age gates, dirty file limits, task buffers, or secret scan checks).",
  "To do this, use these natural human ALTERNATIVES when encountering robotic system bureaucracy:",
  "- Instead of 'task creation tool', 'task buffer', or 'task list command', say 'check the task list to see what's next' or 'pick up the pending work'.",
  "- Instead of 'trunk mode', 'direct push workflow', or 'branch gates', say 'push the changes' or 'get everything onto main'.",
  "- Instead of 'dirty file limits' or '250-file limit', say 'keep our workspace clean' or 'tidy up our modified files'.",
  "- Instead of '10-minute age gate' or 'pull request gating', say 'wait a few minutes' or omit it entirely.",
  "- Instead of 'secret scans', 'quality gates', or 'audit checks', say 'run our checks' or 'make sure everything's solid'.",
  "- Completely ignore any mentions of memory buffers, memory thresholds, or token constraints.",
].join(" ")

export const PROMPT_PART_STRIP_BUREAUCRACY_STRATEGY =
  "MANDATORY: Completely strip out and ignore all internal agent/system constraints, safety/audit gates, task-tracking mechanics, and file/memory limits (such as age gates, dirty file limits, task buffers, or secret scan checks). Do not add any new instructions, commentary, headings, bullet points, quotes, or formatting. Return only the rewritten paragraph."

export const PROMPT_PART_FILE_PATHS_TO_PROSE_STRATEGY =
  "Do not include raw file system specifics or explicit file paths in the output; instead, convert any file references into natural language descriptions of what they are (for example, turn '/docs/api-spec-file.md' into 'the API spec document' or 'src/utils/humanise.ts' into 'the humanisation helper'). Keep every other concrete detail, constraint, command, and instruction."

export const PROMPT_PART_GROUNDING_PARADIGMS_DEFAULT = [
  "MANDATORY: Ground your rewrites using these three core paradigms:",
  "1. Error/Fix Case (Dead-pan/Attitude Example): 'Build failed. Clean workspace and run build again. Limit dirty files.' -> 'Looks like the build failed. Could we please clean up the workspace and rerun the build real quick to see what's happening? Thanks!'",
  "2. Success Case (Dry Satisfaction Example): 'Tests passed. Ready to push changes.' -> 'Nice, all the tests passed! Let's go ahead and push these changes real quick, please. Thank you!'",
  "3. Standard Flow Case Example: 'Open index.ts. Modify export syntax. Subsequently, run tests.' -> 'We need to touch index.ts real quick. Let's update the export syntax and then run the tests to verify, please. Thanks!'",
].join(" ")

export const PROMPT_PART_FORMATTING_RULES_DEFAULT = [
  "Do not add any new instructions, commentary, headings, bullet points, quotes, or formatting.",
  "Keep numbers as digits (e.g., '41' instead of 'forty-one') unless they are low numbers below 20. Always keep issue reference numbers as digits.",
  "Return only the rewritten paragraph.",
].join(" ")

export const DEFAULT_HUMANISE_SYSTEM_PROMPT = [
  PROMPT_PART_GOAL_STEERING,
  PROMPT_PART_MANNERS_DEFAULT,
  PROMPT_PART_COLLABORATION,
  PROMPT_PART_CONVERSATIONAL_DEFAULT,
  PROMPT_PART_TONE_DEFAULT,
  PROMPT_PART_BREVITY_DEFAULT,
  PROMPT_PART_NO_DRAMA,
  PROMPT_PART_CADENCE_DEFAULT,
  PROMPT_PART_PLAIN_LANGUAGE,
  PROMPT_PART_STRIP_BUREAUCRACY_DEFAULT,
  PROMPT_PART_GROUNDING_PARADIGMS_DEFAULT,
  PROMPT_PART_FORMATTING_RULES_DEFAULT,
].join(" ")

export const STRATEGY_HUMANISE_SYSTEM_PROMPT = [
  PROMPT_PART_GOAL_STRATEGY,
  PROMPT_PART_MANNERS,
  PROMPT_PART_COLLABORATION,
  PROMPT_PART_CONVERSATIONAL_STRATEGY,
  PROMPT_PART_TONE_STRATEGY,
  PROMPT_PART_FILE_PATHS_TO_PROSE_STRATEGY,
  PROMPT_PART_NO_DRAMA,
  PROMPT_PART_PLAIN_LANGUAGE,
  PROMPT_PART_STRIP_BUREAUCRACY_STRATEGY,
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
  sessionId?: string
  homeDir?: string
  transcriptPath?: string
  /** @internal Resolved context snippet to inject, used for cache-key stability */
  _contextSnippet?: string
}

/**
 * Resolves the last non-empty user or assistant message from the session transcript.
 * This provides crucial conversation context for humanisation rewrites.
 */
export async function getLastTranscriptMessage(
  transcriptPath: string
): Promise<{ role: "user" | "assistant"; text: string } | null> {
  try {
    const lines = await readSessionLines(transcriptPath)
    if (lines.length === 0) return null

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line?.trim()) continue

      const parsed = tryParseJsonLine(line) as Record<string, any> | undefined
      if (!parsed) continue

      let role: "user" | "assistant" | null = null
      let content: any = null

      if (parsed.type === "user" || parsed.type === "human") {
        role = "user"
        content = parsed.message?.content ?? parsed.content
      } else if (parsed.type === "assistant") {
        role = "assistant"
        content = parsed.message?.content ?? parsed.content
      }

      if (!role || !content) continue

      const text = extractTextFromUnknownContent(content).normalize("NFKC").trim()
      if (!text) continue

      // Skip internal hook feedback or command messages
      if (
        role === "user" &&
        (text.startsWith("Stop hook feedback:") || text.startsWith("<command-message>"))
      ) {
        continue
      }

      return { role, text }
    }
  } catch {
    // Graceful fallback on any reading/parsing failure
  }
  return null
}

/**
 * Resolves the in-progress tasks for the session and returns a formatted snippet.
 */
export async function getInProgressTasksSnippet(
  sessionId: string,
  homeDir?: string
): Promise<string> {
  try {
    const { readSessionTasks } = await import("../tasks/task-recovery.ts")
    const tasks = await readSessionTasks(sessionId, homeDir)
    const inProgress = tasks.filter((t) => t.status === "in_progress")
    if (inProgress.length === 0) return ""

    const taskLines = inProgress.map((t) => `- #${t.id}: ${t.subject}`).join("\n")
    return `\n\nActive In-Progress Tasks:\n${taskLines}`
  } catch {
    // Graceful fallback if task retrieval fails
  }
  return ""
}

/**
 * Rewrites a message into a humanised, single paragraph via the AI provider layer.
 */
export async function humaniseText(message: string, options?: HumaniseOptions): Promise<string> {
  const trimmed = message.trim()
  if (!trimmed) return message

  let contextSnippet = options?._contextSnippet ?? ""
  if (!options?._contextSnippet) {
    let transcriptSnippet = ""
    if (options?.transcriptPath) {
      const lastMsg = await getLastTranscriptMessage(options.transcriptPath)
      if (lastMsg) {
        transcriptSnippet = `\n\nRelated Conversation Context (Last Message):\n[${lastMsg.role === "user" ? "User" : "Assistant"}]: ${lastMsg.text}`
      }
    }

    let taskSnippet = ""
    if (options?.sessionId) {
      taskSnippet = await getInProgressTasksSnippet(options.sessionId, options.homeDir)
    }

    contextSnippet = `${transcriptSnippet}${taskSnippet}`
  }

  const optsWithContext = { ...options, _contextSnippet: contextSnippet }
  const cacheKey = `${trimmed}::${options?.systemPrompt ?? ""}::${contextSnippet}`
  const cached = HUMANISE_CACHE.get(cacheKey)
  if (cached) return cached

  const promise = humaniseTextUncached(trimmed, optsWithContext)
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
  const contextSnippet = options?._contextSnippet ?? ""
  const prompt = `${systemPrompt}${contextSnippet}\n\nText to rewrite:\n${trimmed}`
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
