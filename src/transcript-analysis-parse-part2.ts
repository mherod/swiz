import { z } from "zod"
import {
  parseCodexJsonlEntries,
  parseJsonlEntries,
  parseJunieEvents,
} from "./transcript-analysis-parse-part1.ts"
import { extractTextFromUnknownContent } from "./transcript-extract.ts"
import type { ContentBlock, Session, TranscriptEntry } from "./transcript-schemas.ts"
import { splitJsonlLines, tryParseJsonLine } from "./utils/jsonl.ts"

// ─── Gemini content schemas ───────────────────────────────────────────────────

/** Schema for Gemini text content items */
const geminiTextItemSchema = z.looseObject({
  text: z.string(),
})

function extractGeminiText(content: unknown): string {
  if (typeof content === "string") return content.trim()

  if (Array.isArray(content)) {
    const texts = content
      .map((item) => {
        if (typeof item === "string") return item
        const result = geminiTextItemSchema.safeParse(item)
        return result.success ? result.data.text : ""
      })
      .filter(Boolean)
    return texts.join("\n").trim()
  }

  if (content && typeof content === "object") {
    const textResult = geminiTextItemSchema.safeParse(content)
    if (textResult.success) return textResult.data.text.trim()

    const obj = content as Record<string, any>
    if (Array.isArray(obj.parts)) {
      const texts = obj.parts
        .map((part) => {
          const result = geminiTextItemSchema.safeParse(part)
          return result.success ? result.data.text : ""
        })
        .filter(Boolean)
      return texts.join("\n").trim()
    }
  }

  return ""
}

// ─── Gemini entry schemas ─────────────────────────────────────────────────────

/** Schema for Gemini tool call records */
const geminiToolCallSchema = z.looseObject({
  name: z.string(),
  args: z.unknown().optional(),
})

/** Schema for Gemini session envelope */
const geminiSessionSchema = z.looseObject({
  sessionId: z.string().optional(),
  messages: z.array(z.unknown()),
})

function parseGeminiToolCallBlocks(toolCalls: unknown): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    const toolResult = geminiToolCallSchema.safeParse(call)
    if (!toolResult.success) continue
    const input =
      toolResult.data.args &&
      typeof toolResult.data.args === "object" &&
      !Array.isArray(toolResult.data.args)
        ? (toolResult.data.args as Record<string, any>)
        : {}
    blocks.push({ type: "tool_use", name: toolResult.data.name, input })
  }
  return blocks
}

function classifyGeminiRole(m: Record<string, any>): string {
  if (typeof m.type === "string") return m.type
  if (typeof m.role === "string") return m.role
  return ""
}

const GEMINI_ASSISTANT_ROLES = new Set(["gemini", "assistant", "model"])

function classifyGeminiMessage(
  m: Record<string, any>,
  sessionId: string | undefined,
  entries: TranscriptEntry[]
): void {
  const rawType = classifyGeminiRole(m)
  const timestamp = typeof m.timestamp === "string" ? m.timestamp : undefined

  if (rawType === "info") return

  if (rawType === "user") {
    const text = extractGeminiText(m.content)
    if (text)
      entries.push({ type: "user", sessionId, timestamp, message: { role: "user", content: text } })
    return
  }

  if (GEMINI_ASSISTANT_ROLES.has(rawType)) {
    const blocks: ContentBlock[] = []
    const text = extractGeminiText(m.content)
    if (text) blocks.push({ type: "text", text })
    blocks.push(...parseGeminiToolCallBlocks(m.toolCalls))
    if (blocks.length > 0) {
      entries.push({
        type: "assistant",
        sessionId,
        timestamp,
        message: { role: "assistant", content: blocks },
      })
    }
  }
}

function parseGeminiEntries(text: string): TranscriptEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }

  const sessionResult = geminiSessionSchema.safeParse(parsed)
  if (!sessionResult.success) return []

  const sessionId = sessionResult.data.sessionId
  const entries: TranscriptEntry[] = []

  for (const msg of sessionResult.data.messages) {
    if (!msg || typeof msg !== "object") continue
    classifyGeminiMessage(msg as Record<string, any>, sessionId, entries)
  }

  return entries
}

function advanceStringChar(ch: string, escaped: boolean): { inString: boolean; escaped: boolean } {
  if (escaped) return { inString: true, escaped: false }
  if (ch === "\\") return { inString: true, escaped: true }
  if (ch === '"') return { inString: false, escaped: false }
  return { inString: true, escaped: false }
}

function findMatchingBrace(text: string, startIndex: number): number {
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i]
    if (!ch) continue

    if (inString) {
      const state = advanceStringChar(ch, escaped)
      inString = state.inString
      escaped = state.escaped
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === "{") {
      depth++
      continue
    }
    if (ch === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function parseJsonObjectAt(text: string, startIndex: number): Record<string, any> | null {
  if (text[startIndex] !== "{") return null
  const endIndex = findMatchingBrace(text, startIndex)
  if (endIndex < 0) return null
  try {
    const parsed = JSON.parse(text.slice(startIndex, endIndex + 1)) as Record<string, any>
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

// ─── Cursor content schemas ───────────────────────────────────────────────────

/** Schema for Cursor text content blocks */
const cursorTextBlockSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
})

/** Schema for Cursor tool-call blocks */
const cursorToolCallBlockSchema = z.looseObject({
  type: z.literal("tool-call"),
  toolName: z.string(),
  params: z.unknown().optional(),
})

/** Schema for Cursor tool-result blocks */
const cursorToolResultBlockSchema = z.looseObject({
  type: z.literal("tool-result"),
  result: z.unknown().optional(),
})

function normalizeCursorItem(item: unknown): ContentBlock | null {
  const textResult = cursorTextBlockSchema.safeParse(item)
  if (textResult.success) return { type: "text", text: textResult.data.text }

  const toolCallResult = cursorToolCallBlockSchema.safeParse(item)
  if (toolCallResult.success) {
    const p = toolCallResult.data.params
    const input = p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, any>) : {}
    return { type: "tool_use", name: toolCallResult.data.toolName, input }
  }

  const toolResultResult = cursorToolResultBlockSchema.safeParse(item)
  if (toolResultResult.success) {
    const resultText = extractTextFromUnknownContent(toolResultResult.data.result)
    if (resultText) return { type: "tool_result", content: [{ type: "text", text: resultText }] }
  }
  return null
}

function normalizeCursorContent(content: unknown): string | ContentBlock[] {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map(normalizeCursorItem).filter((b): b is ContentBlock => b !== null)
}

const CURSOR_ROLES = new Set(["user", "assistant", "tool"])

function classifyCursorObject(obj: Record<string, any>, entries: TranscriptEntry[]): void {
  const role = typeof obj.role === "string" ? obj.role : ""
  if (!CURSOR_ROLES.has(role)) return

  const normalizedContent = normalizeCursorContent(obj.content)
  if (!normalizedContent) return
  if (Array.isArray(normalizedContent) && normalizedContent.length === 0) return

  const messageRole = role === "tool" ? "user" : (role as "user" | "assistant")
  entries.push({
    type: messageRole,
    sessionId: typeof obj.id === "string" ? obj.id : undefined,
    timestamp: typeof obj.timestamp === "string" ? obj.timestamp : undefined,
    message: { role: messageRole, content: normalizedContent },
  })
}

function parseCursorSqliteEntries(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  let searchFrom = 0

  while (true) {
    const start = text.indexOf('{"role":', searchFrom)
    if (start === -1) break
    searchFrom = start + 1

    const obj = parseJsonObjectAt(text, start)
    if (!obj) continue
    classifyCursorObject(obj, entries)
  }

  return entries
}

function cleanAntigravityUserRequest(raw: string): string {
  return raw.replace(/^<USER_REQUEST>\n?/, "").replace(/\n?<\/USER_REQUEST>[\s\S]*$/, "")
}

function parseAntigravityToolInput(rawArgs: unknown): Record<string, unknown> {
  let parsedArgs = rawArgs
  if (typeof parsedArgs === "string") {
    try {
      parsedArgs = JSON.parse(parsedArgs)
    } catch {}
  }
  return parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)
    ? (parsedArgs as Record<string, unknown>)
    : {}
}

function parseAntigravityToolCall(
  call: unknown,
  stepIndex: unknown,
  callIdSeq: number
): { block: ContentBlock; callId: string } | null {
  if (
    !call ||
    typeof call !== "object" ||
    typeof (call as Record<string, unknown>).name !== "string"
  ) {
    return null
  }
  const callRec = call as Record<string, unknown>
  const callId = `call_${stepIndex}_${callIdSeq}`
  const input = parseAntigravityToolInput(callRec.args)
  return {
    block: {
      type: "tool_use",
      id: callId,
      name: String(callRec.name),
      input,
    },
    callId,
  }
}

interface AntigravityState {
  callIdSeq: number
  lastToolUseId: string
}

function handleAntigravityUserInput(
  rec: Record<string, unknown>,
  createdAt: string | undefined,
  entries: TranscriptEntry[]
): void {
  const rawContent = typeof rec.content === "string" ? rec.content : ""
  entries.push({
    type: "user",
    timestamp: createdAt,
    message: {
      role: "user",
      content: cleanAntigravityUserRequest(rawContent),
    },
  })
}

function handleAntigravityPlannerResponse(
  rec: Record<string, unknown>,
  createdAt: string | undefined,
  state: AntigravityState,
  entries: TranscriptEntry[]
): void {
  const blocks: ContentBlock[] = []
  if (typeof rec.content === "string" && rec.content.trim().length > 0) {
    blocks.push({ type: "text", text: rec.content })
  }
  if (Array.isArray(rec.tool_calls)) {
    for (const call of rec.tool_calls) {
      state.callIdSeq++
      const result = parseAntigravityToolCall(call, rec.step_index, state.callIdSeq)
      if (result) {
        state.lastToolUseId = result.callId
        blocks.push(result.block)
      }
    }
  }
  if (blocks.length > 0) {
    entries.push({
      type: "assistant",
      timestamp: createdAt,
      message: { role: "assistant", content: blocks },
    })
  }
}

function handleAntigravityToolResult(
  rec: Record<string, unknown>,
  createdAt: string | undefined,
  lastToolUseId: string,
  entries: TranscriptEntry[]
): void {
  if (!lastToolUseId || typeof rec.content !== "string") return
  entries.push({
    type: "user",
    timestamp: createdAt,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: lastToolUseId,
          content: rec.content,
        },
      ],
    },
  })
}

function processAntigravityRecord(
  rec: Record<string, unknown>,
  state: AntigravityState,
  entries: TranscriptEntry[]
): void {
  const { source, type, created_at } = rec
  const createdAt = typeof created_at === "string" ? created_at : undefined

  if (type === "USER_INPUT" || source === "USER_EXPLICIT") {
    handleAntigravityUserInput(rec, createdAt, entries)
  } else if (source === "MODEL" && type === "PLANNER_RESPONSE") {
    handleAntigravityPlannerResponse(rec, createdAt, state, entries)
  } else if (source === "MODEL" && type !== "PLANNER_RESPONSE") {
    handleAntigravityToolResult(rec, createdAt, state.lastToolUseId, entries)
  }
}

export function parseAntigravityJsonlEntries(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  const state: AntigravityState = { callIdSeq: 0, lastToolUseId: "" }

  for (const line of splitJsonlLines(text)) {
    const obj = tryParseJsonLine(line)
    if (obj && typeof obj === "object") {
      processAntigravityRecord(obj as Record<string, unknown>, state, entries)
    }
  }

  return entries
}

const FORMAT_PARSERS: Record<string, (text: string) => TranscriptEntry[]> = {
  "antigravity-pb": () => [],
  "antigravity-jsonl": parseAntigravityJsonlEntries,
  "cursor-sqlite": parseCursorSqliteEntries,
  "cursor-agent-jsonl": parseJsonlEntries,
  "gemini-json": parseGeminiEntries,
  "codex-jsonl": parseCodexJsonlEntries,
  "junie-events": parseJunieEvents,
  jsonl: parseJsonlEntries,
}

function tryDetectSpecializedFormat(text: string): TranscriptEntry[] | null {
  if (text.startsWith("SQLite format 3")) {
    const cursorEntries = parseCursorSqliteEntries(text)
    if (cursorEntries.length > 0) return cursorEntries
  }
  const geminiEntries = parseGeminiEntries(text)
  if (geminiEntries.length > 0) return geminiEntries
  const codexEntries = parseCodexJsonlEntries(text)
  if (codexEntries.length > 0) return codexEntries
  return null
}

function autoDetectTranscriptFormat(text: string): TranscriptEntry[] {
  const specialized = tryDetectSpecializedFormat(text)
  if (specialized) return specialized

  if (text.includes('"step_index"') && text.includes('"source"')) {
    const antigravityEntries = parseAntigravityJsonlEntries(text)
    if (antigravityEntries.length > 0) return antigravityEntries
  }
  if (text.includes('"type":"event"') && text.includes('"payload":')) {
    const junieEntries = parseJunieEvents(text)
    if (junieEntries.length > 0) return junieEntries
  }
  return parseJsonlEntries(text)
}

export function parseTranscriptEntries(
  text: string,
  formatHint?: Session["format"]
): TranscriptEntry[] {
  if (formatHint) {
    const parser = FORMAT_PARSERS[formatHint]
    if (parser) return parser(text)
  }
  return autoDetectTranscriptFormat(text)
}
