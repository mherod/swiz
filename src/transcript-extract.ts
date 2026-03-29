import type { ContentBlock, PlainTurn, TextBlock } from "./transcript-schemas.ts"
import { isTextBlockWithText } from "./transcript-schemas.ts"
import { tryParseJsonLine } from "./utils/jsonl.ts"

// ─── Text extraction ─────────────────────────────────────────────────────────

export function extractText(content: string | ContentBlock[] | undefined): string {
  const normalizeExtractedText = (text: string): string => {
    const userQueryMatch = text.match(/^\s*<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/i)
    if (userQueryMatch) return userQueryMatch[1]!.trim()
    return text.trim()
  }

  if (!content) return ""
  if (typeof content === "string") return normalizeExtractedText(content)
  if (!Array.isArray(content)) return ""
  return normalizeExtractedText(
    content
      .filter((b): b is TextBlock => b.type === "text" && !!(b as TextBlock).text)
      .map((b) => b.text!)
      .join("\n")
  )
}

export function extractTextFromUnknownContent(content: unknown): string {
  const normalizeExtractedText = (text: string): string => {
    const userQueryMatch = text.match(/^\s*<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/i)
    if (userQueryMatch) return userQueryMatch[1]!.trim()
    return text.trim()
  }

  if (typeof content === "string") return normalizeExtractedText(content)
  if (!Array.isArray(content)) return ""
  return normalizeExtractedText(
    content
      .filter(isTextBlockWithText)
      .map((block) => block.text)
      .join("\n")
  )
}

/**
 * Strip quoted text and code blocks from a string.
 * Prevents false positives when pattern-matching against agent text
 * that quotes trigger phrases from prior denials.
 */
export function stripQuotedText(text: string): string {
  return text
    .replace(/`[^`]*`/g, "") // inline code
    .replace(/```[\s\S]*?```/g, "") // fenced code blocks
    .replace(/"[^"]*"/g, "") // double-quoted
    .replace(/(?<!\w)'[^']*'(?!\w)/g, "") // single-quoted (lookbehind avoids contractions)
    .replace(/\u2018[^\u2019]*\u2019/g, "") // smart single quotes
    .replace(/\u201c[^\u201d]*\u201d/g, "") // smart double quotes
}

/** Extract joined text from a parsed assistant transcript entry, or empty string. */
function extractTextFromEntry(entry: Record<string, unknown>): string {
  if (entry?.type !== "assistant") return ""
  const content = (entry as { message?: { content?: unknown[] } })?.message?.content
  if (!Array.isArray(content)) return ""
  const texts = content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
    )
    .map((block) => block.text)
  return texts.length > 0 ? texts.join(" ") : ""
}

/**
 * Extract text content from the last assistant message in transcript lines.
 * Walks backward through JSONL lines for efficiency.
 */
export function extractLastAssistantText(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line?.trim()) continue
    const parsed = tryParseJsonLine(line)
    if (parsed === undefined || typeof parsed !== "object" || Array.isArray(parsed)) continue
    const text = extractTextFromEntry(parsed as Record<string, unknown>)
    if (text) return text
  }
  return ""
}

/**
 * Read transcript lines from a file path.
 * Returns empty array if file cannot be read.
 */
export async function readTranscriptLines(transcriptPath: string): Promise<string[]> {
  if (!transcriptPath) return []
  try {
    const text = await Bun.file(transcriptPath).text()
    return text.split("\n")
  } catch {
    return []
  }
}

export function isHookFeedback(content: string | ContentBlock[] | undefined): boolean {
  const text = extractText(content)
  return text.startsWith("Stop hook feedback:") || text.startsWith("<command-message>")
}

// ─── Plain turn section helpers (shared by continue / stop-auto-continue) ───

export function buildTaskSection(taskContext: string): string {
  if (!taskContext) return ""
  return `=== SESSION TASKS ===\n${taskContext}\n=== END OF SESSION TASKS ===\n\n`
}

export function buildUserMessagesSection(turns: PlainTurn[]): string {
  const userTurns = turns.filter((t) => t.role === "user")
  if (userTurns.length === 0) return ""
  return `=== USER'S MESSAGES ===\n${userTurns.map((t) => `- ${t.text}`).join("\n\n")}\n=== END OF USER'S MESSAGES ===\n\n`
}

const TOOL_RESULT_TRUNCATE = 400

export function extractToolResultText(block: {
  content?: string | ContentBlock[]
  is_error?: boolean
}): string {
  const text = extractTextFromUnknownContent(block.content)
  if (!text) return ""
  const prefix = block.is_error ? "Error: " : ""
  const truncated =
    text.length > TOOL_RESULT_TRUNCATE ? `${text.slice(0, TOOL_RESULT_TRUNCATE)}…` : text
  return `${prefix}${truncated}`
}
