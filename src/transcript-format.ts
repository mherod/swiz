import { format } from "date-fns"
import type { DisplayTurn } from "../scripts/transcript/monitor-state.ts"
import {
  type ContentBlock,
  extractText,
  extractTextFromUnknownContent,
  isTextBlockWithText,
  type TextBlock,
  type ToolResultBlock,
  type ToolUseBlock,
  toolUseBlockSchema,
} from "./transcript-utils.ts"

// ─── Tool-use label formatting ────────────────────────────────────────────────

const TOOL_KEY_PARAM: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  Bash: "command",
  Shell: "command",
  run_shell_command: "command",
  shell_command: "command",
  exec_command: "command",
  Glob: "pattern",
  Grep: "pattern",
  WebFetch: "url",
  WebSearch: "query",
}

const TOOL_LABEL_MAX = 70

function truncateLabel(value: string, max = TOOL_LABEL_MAX): string {
  return value.slice(0, max)
}

export function formatToolUse(name: string, input: NonNullable<ToolUseBlock["input"]>): string {
  if (name === "Task" && input.subagent_type) {
    const desc = typeof input.description === "string" ? truncateLabel(input.description) : ""
    return `${input.subagent_type}(${desc})`
  }
  const param = TOOL_KEY_PARAM[name]
  if (param && input[param] !== undefined) {
    if (param === "command") return `${name}(${String(input[param])})`
    return `${name}(${truncateLabel(String(input[param]))})`
  }
  const firstStr = Object.values(input).find((v) => typeof v === "string")
  if (firstStr) return `${name}(${truncateLabel(String(firstStr))})`
  return name
}

// ─── Content block helpers ──────────────────────────────────────────────────

export function toContentBlocks(content: string | ContentBlock[] | undefined): ContentBlock[] {
  if (!content) return []
  return typeof content === "string" ? [{ type: "text", text: content }] : content
}

export function isVisibleTextBlock(block: ContentBlock): block is TextBlock & { text: string } {
  return isTextBlockWithText(block) && block.text.trim().length > 0
}

export function isNamedToolUseBlock(block: ContentBlock): block is ToolUseBlock & { name: string } {
  const result = toolUseBlockSchema.safeParse(block)
  return result.success && typeof result.data.name === "string"
}

export function hasToolResults(content: string | ContentBlock[] | undefined): boolean {
  return Array.isArray(content) && content.some((block) => block.type === "tool_result")
}

export function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ""
    return format(d, "HH:mm")
  } catch {
    return ""
  }
}

// ─── Display turn conversion ────────────────────────────────────────────────

const TOOL_RESULT_DISPLAY_MAX = 600

type DisplayBlock = NonNullable<DisplayTurn["blocks"]>[number]

function extractToolResultBlocks(content: ContentBlock[]): DisplayBlock[] {
  const results: DisplayBlock[] = []
  for (const b of content) {
    if (b.type !== "tool_result") continue
    const text = extractTextFromUnknownContent((b as ToolResultBlock).content)
    if (!text) continue
    const truncated =
      text.length > TOOL_RESULT_DISPLAY_MAX
        ? `${text.slice(0, TOOL_RESULT_DISPLAY_MAX)}… (truncated)`
        : text
    results.push({
      type: "tool_result",
      text: truncated,
      isError: !!(b as ToolResultBlock).is_error,
    })
  }
  return results
}

function assistantToDisplayTurn(entry: {
  message?: { content?: string | ContentBlock[] }
  timestamp?: string
}): DisplayTurn {
  const blocks = toContentBlocks(entry.message?.content)
  const displayBlocks: DisplayBlock[] = []
  for (const block of blocks) {
    if (isVisibleTextBlock(block)) {
      displayBlocks.push({ type: "text", text: block.text.trim() })
    } else if (isNamedToolUseBlock(block)) {
      const label = formatToolUse(block.name, block.input ?? {})
      displayBlocks.push({ type: "tool_use", toolLabel: label })
    }
  }
  const content = entry.message?.content
  if (Array.isArray(content)) {
    displayBlocks.push(...extractToolResultBlocks(content))
  }
  return { role: "assistant", timestamp: entry.timestamp, blocks: displayBlocks }
}

export function entryToDisplayTurn(
  entry: { type?: string; message?: { content?: string | ContentBlock[] }; timestamp?: string },
  role: "user" | "assistant"
): DisplayTurn {
  if (role === "assistant") return assistantToDisplayTurn(entry)

  const content = entry.message?.content
  if (hasToolResults(content) && Array.isArray(content)) {
    return {
      role,
      timestamp: entry.timestamp,
      blocks: extractToolResultBlocks(content),
    }
  }
  return { role, timestamp: entry.timestamp, text: extractText(content).trim() }
}
