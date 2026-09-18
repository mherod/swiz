#!/usr/bin/env bun

/**
 * UserPromptSubmit hook: Uses the user's prompt as a jbcontext semantic search query
 * and emits the top relevant code snippets as hook context.
 */

import {
  buildContextHookOutput,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import { type UserPromptSubmitHookInput, userPromptSubmitHookInputSchema } from "../src/schemas.ts"
import { isJbcontextConfigured, resolveJbcontextBinary } from "../src/utils/jbcontext.ts"
import { spawnWithTimeout } from "../src/utils/process-utils.ts"
import { readLastTranscriptUserMessage } from "../src/utils/transcript-user-message.ts"

const SKILL_INVOCATION_RE = /^\s*\/[a-z0-9-]+/i
const MAX_QUERY_LENGTH = 250
const SEARCH_LIMIT = 3
const SEARCH_TIMEOUT_MS = 5_000

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

export function formatJbcontextSearchResults(
  query: string,
  items: readonly JbcontextSearchResultItem[]
): string {
  const lines: string[] = [
    "JetBrains Context semantic code search for user prompt:",
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
    return results.filter((item) =>
      Boolean(item.result?.sourcePosition?.relativePath && item.content)
    )
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
  const query = extractSearchQuery(rawPrompt)
  if (!query) {
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
