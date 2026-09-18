#!/usr/bin/env bun

/**
 * UserPromptSubmit hook: Uses the user's prompt as a jbcontext semantic search query
 * and emits the top relevant code snippets as hook context.
 *
 * The raw prompt alone is a weak query: conversational turns ("how helpful was it?")
 * carry no code signal and retrieve noise. The query is therefore grounded with
 * session context — in-progress task subjects and the code identifiers named in the
 * last assistant message — so a follow-up inherits the terms of the work in flight.
 */

import {
  buildContextHookOutput,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import { type UserPromptSubmitHookInput, userPromptSubmitHookInputSchema } from "../src/schemas.ts"
import { extractLastAssistantText } from "../src/transcript-extract.ts"
import { isJbcontextConfigured, resolveJbcontextBinary } from "../src/utils/jbcontext.ts"
import { spawnWithTimeout } from "../src/utils/process-utils.ts"
import { readSessionLines } from "../src/utils/transcript.ts"
import { readLastTranscriptUserMessage } from "../src/utils/transcript-user-message.ts"

const SKILL_INVOCATION_RE = /^\s*\/[a-z0-9-]+/i
const MAX_QUERY_LENGTH = 250
const SEARCH_LIMIT = 3
const SEARCH_TIMEOUT_MS = 5_000

/** Grounding terms appended to the prompt before searching. */
const MAX_GROUNDING_TERMS = 4
/** In-progress task subjects are prose; keep the query prompt-dominant. */
const MAX_GROUNDING_TASKS = 2
const MAX_GROUNDED_QUERY_LENGTH = 400

/**
 * Minimum jbcontext similarity for a result to be worth the context budget.
 * Results below this are plausible-looking but unrelated code, which misdirects
 * more than it helps.
 */
const MIN_SIMILARITY = 0.3

export interface JbcontextSearchResultItem {
  content?: string
  contentStartLine?: number
  result?: {
    scoredText?: { similarity?: number }
    sourcePosition?: {
      relativePath?: string
      startOffset?: number
      endOffset?: number
    }
  }
}

export interface JbcontextSearchOutput {
  type?: string
  results?: JbcontextSearchResultItem[]
  message?: string
}

export function cleanPromptForQuery(rawPrompt: string): string {
  const cleaned = rawPrompt
    .replace(/<\/?USER_REQUEST>/g, "")
    .replace(/<[^>]+>/g, "")
    .trim()

  const firstLine = cleaned.split("\n")[0]?.trim() || ""
  if (firstLine.length >= 10 && firstLine.length <= MAX_QUERY_LENGTH) {
    return firstLine
  }
  return cleaned.slice(0, MAX_QUERY_LENGTH).trim()
}

export function extractSearchQuery(rawPrompt: string): string | null {
  if (!rawPrompt || SKILL_INVOCATION_RE.test(rawPrompt.trim())) {
    return null
  }
  const query = cleanPromptForQuery(rawPrompt)
  return query.length >= 5 ? query : null
}

/**
 * Patterns for code-shaped tokens worth carrying into a semantic query.
 * Prose from an assistant message would swamp the prompt; identifiers and paths
 * are short and high-signal.
 */
const CODE_TERM_PATTERNS: readonly RegExp[] = [
  /`([^`\n]{2,60})`/g, // backticked spans
  /\b([\w-]+(?:\/[\w.-]+)+\.[a-z]{2,4})\b/g, // path-like: src/utils/foo.ts
  /\b([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)\b/g, // camelCase
  /\b([A-Z][a-z0-9]+[A-Z][a-zA-Z0-9]*)\b/g, // PascalCase
  /\b([a-z][a-z0-9]*(?:[_-][a-z0-9]+)+)\b/g, // snake_case / kebab-case
]

/** Extract up to `limit` distinct code-shaped terms from free text. */
export function extractCodeTerms(text: string, limit: number = MAX_GROUNDING_TERMS): string[] {
  if (!text.trim()) return []
  const seen = new Set<string>()
  const terms: string[] = []
  for (const pattern of CODE_TERM_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const term = match[1]?.trim()
      if (!term) continue
      const key = term.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      terms.push(term)
      if (terms.length >= limit) return terms
    }
  }
  return terms
}

/**
 * Combine the prompt with session grounding terms. The prompt stays first and
 * dominant so an explicit code question is never diluted by stale grounding.
 */
export function buildGroundedQuery(prompt: string, groundingTerms: readonly string[]): string {
  if (groundingTerms.length === 0) return prompt
  const promptTokens = new Set(prompt.toLowerCase().split(/\W+/).filter(Boolean))
  const additions = groundingTerms.filter((term) => !promptTokens.has(term.toLowerCase()))
  if (additions.length === 0) return prompt
  return `${prompt} ${additions.join(" ")}`.slice(0, MAX_GROUNDED_QUERY_LENGTH).trim()
}

/**
 * Gather grounding terms for the current session: in-progress task subjects plus
 * the code identifiers named in the last assistant message. Both sources are
 * read post-compaction-boundary, so grounding never resurrects finished work.
 */
export async function collectSessionGrounding(input: UserPromptSubmitHookInput): Promise<string[]> {
  const terms: string[] = []

  if (input.session_id) {
    try {
      // Dynamic import mirrors humanise.ts: avoids a hook → tasks → manifest cycle.
      const { readSessionTasks } = await import("../src/tasks/task-recovery.ts")
      const tasks = await readSessionTasks(input.session_id)
      for (const task of tasks) {
        if (task.status !== "in_progress" || !task.subject) continue
        terms.push(task.subject)
        if (terms.length >= MAX_GROUNDING_TASKS) break
      }
    } catch {
      // Grounding is best-effort; a task-store failure must not drop the search.
    }
  }

  if (input.transcript_path) {
    const lines = await readSessionLines(input.transcript_path)
    terms.push(...extractCodeTerms(extractLastAssistantText(lines), MAX_GROUNDING_TERMS))
  }

  const seen = new Set<string>()
  return terms
    .filter((term) => {
      const key = term.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, MAX_GROUNDING_TERMS)
}

export function formatJbcontextSearchResults(
  query: string,
  items: readonly JbcontextSearchResultItem[]
): string {
  const lines: string[] = [
    "JetBrains Context semantic code search (query grounded in session context):",
    `> "${query}"`,
    "",
  ]

  items.slice(0, SEARCH_LIMIT).forEach((item, index) => {
    const relPath = item.result?.sourcePosition?.relativePath ?? "unknown"
    const startLine = item.contentStartLine ?? 1
    const content = item.content?.trim() ?? ""

    lines.push(`${index + 1}. \`${relPath}\` (line ${startLine}):`)
    if (content) {
      lines.push("```")
      lines.push(content)
      lines.push("```")
    }
  })

  return lines.join("\n")
}

export async function readPromptText(input: UserPromptSubmitHookInput): Promise<string> {
  if (typeof (input as { prompt?: unknown }).prompt === "string") {
    return (input as { prompt: string }).prompt
  }
  if (input.transcript_path) {
    const lastMsg = await readLastTranscriptUserMessage(input.transcript_path)
    if (lastMsg?.text) {
      return lastMsg.text
    }
  }
  return ""
}

function hasUsableSource(item: JbcontextSearchResultItem): boolean {
  return Boolean(item.result?.sourcePosition?.relativePath && item.content)
}

/**
 * Drop weakly-matching results. A missing similarity score is treated as passing:
 * the floor exists to trim known-bad matches, not to suppress every result when
 * jbcontext omits scoring.
 */
export function meetsSimilarityFloor(item: JbcontextSearchResultItem): boolean {
  const similarity = item.result?.scoredText?.similarity
  if (typeof similarity !== "number" || Number.isNaN(similarity)) return true
  return similarity >= MIN_SIMILARITY
}

async function executeJbcontextSearch(
  binaryPath: string,
  cwd: string,
  query: string
): Promise<JbcontextSearchResultItem[]> {
  try {
    const proc = await spawnWithTimeout(
      [
        binaryPath,
        "search",
        `--project-path=${cwd}`,
        `--limit=${SEARCH_LIMIT}`,
        "--json-output",
        query,
      ],
      { timeoutMs: SEARCH_TIMEOUT_MS }
    )

    if (proc.exitCode !== 0 || !proc.stdout.trim()) {
      return []
    }

    const parsed = JSON.parse(proc.stdout) as JbcontextSearchOutput
    const results = Array.isArray(parsed.results) ? parsed.results : []
    return results.filter((item) => hasUsableSource(item) && meetsSimilarityFloor(item))
  } catch {
    return []
  }
}

export async function evaluateUserpromptsubmitJbcontextSearch(
  input: unknown
): Promise<SwizHookOutput> {
  const hookInput: UserPromptSubmitHookInput = userPromptSubmitHookInputSchema.parse(input)
  const cwd = hookInput.cwd ?? process.cwd()

  const rawPrompt = await readPromptText(hookInput)
  const promptQuery = extractSearchQuery(rawPrompt)
  if (!promptQuery) {
    return {}
  }

  const configured = await isJbcontextConfigured({
    projectPath: cwd,
    requireProjectIndexed: false,
  })
  if (!configured) {
    return {}
  }

  const binaryPath = await resolveJbcontextBinary()
  if (!binaryPath) {
    return {}
  }

  const groundingTerms = await collectSessionGrounding(hookInput)
  const query = buildGroundedQuery(promptQuery, groundingTerms)

  const validItems = await executeJbcontextSearch(binaryPath, cwd, query)
  if (validItems.length === 0) {
    return {}
  }

  const contextText = formatJbcontextSearchResults(query, validItems)
  return buildContextHookOutput("UserPromptSubmit", contextText)
}

const userpromptsubmitJbcontextSearch: SwizHook<Record<string, any>> = {
  name: "userpromptsubmit-jbcontext-search",
  event: "userPromptSubmit",
  timeout: 10,
  run(input) {
    return evaluateUserpromptsubmitJbcontextSearch(input)
  },
}

export default userpromptsubmitJbcontextSearch

if (import.meta.main) {
  await runSwizHookAsMain(userpromptsubmitJbcontextSearch)
}
