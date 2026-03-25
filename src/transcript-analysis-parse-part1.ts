import { z } from "zod"
import type { ContentBlock, TranscriptEntry } from "./transcript-schemas.ts"
import { toolResultBlockSchema, toolUseBlockSchema } from "./transcript-schemas.ts"

function toolCallLabel(block: { name?: string; input?: Record<string, unknown> }): string {
  const name = block.name ?? "unknown"
  const input = block.input
  if (!input) return name

  const pathVal = input.path ?? input.file_path
  if (typeof pathVal === "string") return `${name}(${pathVal})`

  if (typeof input.command === "string") {
    // Keep shell commands lossless in transcript-derived context so
    // downstream review/enforcement can see the full operation.
    return `${name}(${input.command})`
  }

  if (typeof input.pattern === "string") return `${name}(${input.pattern})`
  if (typeof input.glob_pattern === "string") return `${name}(${input.glob_pattern})`
  if (typeof input.query === "string") {
    const q = input.query.length > 60 ? `${input.query.slice(0, 57)}...` : input.query
    return `${name}(${q})`
  }

  return name
}
function isToolUseSummaryBlock(block: unknown): block is {
  type: "tool_use"
  name: string
  input?: Record<string, unknown>
} {
  const result = toolUseBlockSchema.safeParse(block)
  return result.success && typeof result.data.name === "string"
}

export function isToolResultSummaryBlock(block: unknown): block is {
  type: "tool_result"
  content?: string | ContentBlock[]
  is_error?: boolean
} {
  return toolResultBlockSchema.safeParse(block).success
}

export function summarizeToolCalls(content: unknown[]): string {
  const calls = content.filter(isToolUseSummaryBlock).map((b) => toolCallLabel(b))
  if (calls.length === 0) return ""
  return `[Tools: ${calls.join(", ")}]`
}

/**
 * Schema for JSONL transcript entries from Claude and similar providers.
 * Validates the basic structure and provides type-safe access to fields.
 */
const jsonlEntrySchema = z.looseObject({
  type: z.string().optional(),
  role: z.string().optional(),
  sessionId: z.string().optional(),
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
  message: z
    .looseObject({
      role: z.string().optional(),
      content: z.unknown().optional(),
    })
    .optional(),
})

export function parseJsonlEntries(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const line of text.split("\n").filter(Boolean)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const result = jsonlEntrySchema.safeParse(parsed)
    if (!result.success) continue

    const entry = result.data

    // Coerce role → type when type is missing
    if (typeof entry.type !== "string" && typeof entry.role === "string") {
      const role = entry.role
      if (role === "user" || role === "assistant") {
        entry.type = role
      }
    }
    entries.push(entry as TranscriptEntry)
  }
  return entries
}

// ─── Zod schemas for provider-specific transcript records ─────────────────────

/**
 * Schema for Codex message content parts (input_text, output_text).
 * Replaces manual `as Record<string, unknown>` casts with type-safe validation.
 */
const codexContentPartSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
})

function extractCodexMessageText(content: unknown, textType: "input_text" | "output_text"): string {
  if (!Array.isArray(content)) return ""
  const texts = content
    .map((part) => {
      const result = codexContentPartSchema.safeParse(part)
      if (!result.success || result.data.type !== textType) return ""
      return result.data.text ?? ""
    })
    .filter(Boolean)
  return texts.join("\n").trim()
}

function parseCodexToolInput(raw: unknown): Record<string, unknown> {
  const normalize = (value: Record<string, unknown>): Record<string, unknown> => {
    if (typeof value.command !== "string" && typeof value.cmd === "string") {
      return { ...value, command: value.cmd }
    }
    return value
  }

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return normalize(raw as Record<string, unknown>)
  }
  if (typeof raw !== "string") return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return normalize(parsed)
    }
  } catch {}
  return {}
}

// ─── Codex record schemas ─────────────────────────────────────────────────────

/** Schema for Codex session_meta records */
const codexSessionMetaSchema = z.looseObject({
  type: z.literal("session_meta"),
  timestamp: z.string().optional(),
  payload: z.looseObject({
    id: z.string().optional(),
    cwd: z.string().optional(),
  }),
})

/** Schema for Codex event_msg records (user messages) */
const codexEventMsgSchema = z.looseObject({
  type: z.literal("event_msg"),
  timestamp: z.string().optional(),
  payload: z.looseObject({
    type: z.literal("user_message"),
    message: z.string().optional(),
  }),
})

/** Schema for Codex response_item records (assistant messages and tool calls) */
const codexResponseItemSchema = z.looseObject({
  type: z.literal("response_item"),
  timestamp: z.string().optional(),
  payload: z.looseObject({
    type: z.string(),
    role: z.string().optional(),
    content: z.unknown().optional(),
    name: z.string().optional(),
    arguments: z.unknown().optional(),
  }),
})

function classifyCodexLine(
  parsed: unknown,
  sessionId: string | undefined,
  entries: TranscriptEntry[]
): string | undefined {
  const sessionMetaResult = codexSessionMetaSchema.safeParse(parsed)
  if (sessionMetaResult.success) {
    const id = sessionMetaResult.data.payload.id?.trim()
    return id || sessionId
  }

  const eventMsgResult = codexEventMsgSchema.safeParse(parsed)
  if (eventMsgResult.success) {
    const message = eventMsgResult.data.payload.message?.trim()
    if (message) {
      entries.push({
        type: "user",
        sessionId,
        timestamp: eventMsgResult.data.timestamp,
        message: { role: "user", content: message },
      })
    }
    return sessionId
  }

  const responseItemResult = codexResponseItemSchema.safeParse(parsed)
  if (!responseItemResult.success) return sessionId
  classifyCodexResponseItem(responseItemResult.data, sessionId, entries)
  return sessionId
}

interface CodexResponseData {
  timestamp?: string
  payload: { type: string; role?: string; content?: unknown; name?: string; arguments?: unknown }
}

function classifyCodexResponseItem(
  data: CodexResponseData,
  sessionId: string | undefined,
  entries: TranscriptEntry[]
): void {
  const { timestamp, payload } = data
  if (payload.type === "message" && payload.role === "assistant") {
    const text = extractCodexMessageText(payload.content, "output_text")
    if (text) {
      entries.push({
        type: "assistant",
        sessionId,
        timestamp,
        message: { role: "assistant", content: [{ type: "text", text }] },
      })
    }
    return
  }
  if (payload.type === "function_call" && payload.name) {
    entries.push({
      type: "assistant",
      sessionId,
      timestamp,
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: payload.name, input: parseCodexToolInput(payload.arguments) },
        ],
      },
    })
  }
}

export function parseCodexJsonlEntries(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  let sessionId: string | undefined

  for (const line of text.split("\n").filter(Boolean)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    sessionId = classifyCodexLine(parsed, sessionId, entries)
  }

  return entries
}
