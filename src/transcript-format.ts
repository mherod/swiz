import { format } from "date-fns"
import type { DisplayTurn } from "../scripts/transcript/monitor-state.ts"
import {
  extractSkillInvocationPreamble,
  extractSkillNameFromSkillMdPathText,
  extractSkillNamesFromShellSkillReadCommand,
  startsWithSkillInvocationPreamble,
} from "./skill-usage.ts"
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
    const val = String(input[param])
    if (param === "command") {
      const skill = extractSkillNamesFromShellSkillReadCommand(val)[0]
      if (skill) return `skill(${skill})`
      return `${name}(${val})`
    }
    if (param === "file_path") {
      const skill = extractSkillNameFromSkillMdPathText(val)
      if (skill) return `skill(${skill})`
    }
    return `${name}(${truncateLabel(val)})`
  }
  const firstStr = Object.values(input).find((v) => typeof v === "string")
  if (firstStr) return `${name}(${truncateLabel(String(firstStr))})`
  return name
}

// ─── Slash-command / local-command tag parsing ───────────────────────────────

const ANSI_STRIP_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, "g")
const COMMAND_TAG_RE =
  /<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)>([\s\S]*?)<\/\1>/gi
const SYSTEM_TAG_START_RE =
  /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/i

function stripAnsiLike(text: string): string {
  return text.replace(ANSI_STRIP_RE, "").replace(/\[\d+(?:;\d+)*m/g, "")
}

export interface PrettyUserMessage {
  /** Final text to display, or null to suppress the turn entirely. */
  text: string | null
  /** Optional category for styling hooks downstream. */
  kind?: "slash-command" | "command-output" | "command-error" | "skill-invocation"
}

/**
 * Convert raw user transcript text containing `<command-name>`,
 * `<command-args>`, `<local-command-stdout>`, or `<local-command-caveat>`
 * tags into a readable single-line representation. Returns `null` when
 * the message is purely a caveat with no other content (so the caller
 * can drop the turn). Returns `undefined` when no transformation is
 * needed and the raw text should be used as-is.
 */
export function prettifyUserMessageText(raw: string): PrettyUserMessage | undefined {
  const startsWithSystemTag = SYSTEM_TAG_START_RE.test(raw)
  const startsWithBareSkill = startsWithSkillInvocationPreamble(raw)
  if (!startsWithSystemTag && !startsWithBareSkill) return undefined

  if (!startsWithSystemTag && startsWithBareSkill) {
    const skill = extractSkillInvocationPreamble(raw)
    if (skill) {
      const slash = skill.name ? `/${skill.name}` : "(skill body)"
      const label = skill.rest ? `${slash}\n${skill.rest}` : slash
      return { text: label, kind: "skill-invocation" }
    }
    return undefined
  }

  const tags: Record<string, string> = {}
  let remainder = ""
  let lastEnd = 0
  for (const match of raw.matchAll(new RegExp(COMMAND_TAG_RE.source, "gi"))) {
    const index = match.index ?? 0
    remainder += raw.slice(lastEnd, index)
    lastEnd = index + match[0].length
    const name = match[1]!.toLowerCase()
    if (!(name in tags)) tags[name] = match[2]!.trim()
  }
  if (Object.keys(tags).length === 0) return undefined
  remainder = (remainder + raw.slice(lastEnd)).trim()

  const skill = extractSkillInvocationPreamble(remainder)
  if (skill) remainder = skill.rest

  if ("command-name" in tags) {
    const cmdName = tags["command-name"]!
    const normalized = cmdName.startsWith("/") ? cmdName : `/${cmdName}`
    const args = tags["command-args"]
    const label = args ? `${normalized} ${args}` : normalized
    const kind: PrettyUserMessage["kind"] = skill ? "skill-invocation" : "slash-command"
    return { text: remainder ? `${label}\n${remainder}` : label, kind }
  }

  if ("bash-input" in tags) {
    const cmd = tags["bash-input"]!
    if (!cmd) return remainder ? { text: remainder } : { text: null }
    return {
      text: remainder ? `${remainder}\n$ ${cmd}` : `$ ${cmd}`,
      kind: "slash-command",
    }
  }

  if ("bash-stdout" in tags) {
    const cleaned = stripAnsiLike(tags["bash-stdout"] ?? "")
    if (!cleaned) return remainder ? { text: remainder } : { text: null }
    return {
      text: remainder ? `${remainder}\n↳ ${cleaned}` : `↳ ${cleaned}`,
      kind: "command-output",
    }
  }

  if ("bash-stderr" in tags) {
    const cleaned = stripAnsiLike(tags["bash-stderr"] ?? "")
    if (!cleaned) return remainder ? { text: remainder } : { text: null }
    return {
      text: remainder ? `${remainder}\n✗ ${cleaned}` : `✗ ${cleaned}`,
      kind: "command-error",
    }
  }

  if (skill) {
    const slash = skill.name ? `/${skill.name}` : "(skill body)"
    return {
      text: remainder ? `${slash}\n${remainder}` : slash,
      kind: "skill-invocation",
    }
  }

  if ("local-command-stdout" in tags) {
    const cleaned = stripAnsiLike(tags["local-command-stdout"] ?? "")
    if (!cleaned) return remainder ? { text: remainder } : { text: null }
    return {
      text: remainder ? `${remainder}\n↳ ${cleaned}` : `↳ ${cleaned}`,
      kind: "command-output",
    }
  }

  if ("local-command-stderr" in tags) {
    const cleaned = stripAnsiLike(tags["local-command-stderr"] ?? "")
    if (!cleaned) return remainder ? { text: remainder } : { text: null }
    return {
      text: remainder ? `${remainder}\n✗ ${cleaned}` : `✗ ${cleaned}`,
      kind: "command-error",
    }
  }

  if ("local-command-caveat" in tags) {
    return remainder ? { text: remainder } : { text: null }
  }

  return undefined
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
  const rawText = extractText(content).trim()
  const pretty = prettifyUserMessageText(rawText)
  const text = pretty?.text === null ? "" : (pretty?.text ?? rawText)
  return { role, timestamp: entry.timestamp, text }
}
