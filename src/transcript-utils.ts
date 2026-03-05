import { readdir, readFile, stat } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { getProviderSessionDir } from "./provider-utils.ts"

// ─── Content block types ─────────────────────────────────────────────────────

export interface TextBlock {
  type: "text"
  text?: string
}

export interface ToolUseBlock {
  type: "tool_use"
  id?: string
  name?: string
  input?: Record<string, unknown>
}

export interface ToolResultBlock {
  type: "tool_result"
  tool_use_id?: string
  content?: string | ContentBlock[]
  is_error?: boolean
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | { type: string; [key: string]: unknown }

export interface TranscriptEntry {
  type: string
  sessionId?: string
  timestamp?: string
  cwd?: string
  message?: {
    role?: string
    content?: string | ContentBlock[]
  }
}

// ─── Session discovery ───────────────────────────────────────────────────────

export interface Session {
  id: string
  path: string
  mtime: number
  provider?: "claude" | "gemini"
  format?: "jsonl" | "gemini-json"
}

export function projectKeyFromCwd(cwd: string): string {
  return cwd.replace(/[/.\\:]/g, "-")
}

export async function findSessions(projectDir: string): Promise<Session[]> {
  let entries: string[]
  try {
    entries = await readdir(projectDir)
  } catch {
    return []
  }

  const sessions: Session[] = []
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue
    const id = entry.slice(0, -6)
    const filePath = join(projectDir, entry)
    try {
      const s = await stat(filePath)
      sessions.push({ id, path: filePath, mtime: s.mtimeMs })
    } catch {}
  }

  return sessions.sort((a, b) => b.mtime - a.mtime)
}

async function readProjectRoot(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, "utf-8")
    const trimmed = raw.trim()
    return trimmed ? resolve(trimmed) : null
  } catch {
    return null
  }
}

async function readGeminiSessionId(sessionPath: string): Promise<string | null> {
  try {
    const parsed = (await Bun.file(sessionPath).json()) as Record<string, unknown>
    const sessionId = parsed.sessionId
    if (typeof sessionId === "string" && sessionId.trim()) {
      return sessionId
    }
  } catch {}
  return null
}

async function findGeminiSessions(targetDir: string): Promise<Session[]> {
  const home = process.env.HOME ?? "~"
  const geminiTmp = join(home, ".gemini", "tmp")
  const geminiHistory = join(home, ".gemini", "history")
  const target = resolve(targetDir)
  const bucketFallbackName = basename(target)
  const sessions: Session[] = []

  let buckets: import("node:fs").Dirent[]
  try {
    buckets = await readdir(geminiTmp, { withFileTypes: true })
  } catch {
    return []
  }

  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    const bucketDir = join(geminiTmp, bucket.name)
    const roots = new Set<string>()

    const tmpRoot = await readProjectRoot(join(bucketDir, ".project_root"))
    if (tmpRoot) roots.add(tmpRoot)

    const historyRoot = await readProjectRoot(join(geminiHistory, bucket.name, ".project_root"))
    if (historyRoot) roots.add(historyRoot)

    const matchesTarget =
      roots.size > 0
        ? [...roots].some((root) => root === target)
        : bucket.name === bucketFallbackName
    if (!matchesTarget) continue

    const chatsDir = join(bucketDir, "chats")
    let chatEntries: import("node:fs").Dirent[]
    try {
      chatEntries = await readdir(chatsDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const chatEntry of chatEntries) {
      if (!chatEntry.isFile()) continue
      if (!chatEntry.name.startsWith("session-") || !chatEntry.name.endsWith(".json")) continue

      const sessionPath = join(chatsDir, chatEntry.name)
      try {
        const s = await stat(sessionPath)
        const id = (await readGeminiSessionId(sessionPath)) ?? chatEntry.name.replace(/\.json$/, "")
        sessions.push({
          id,
          path: sessionPath,
          mtime: s.mtimeMs,
          provider: "gemini",
          format: "gemini-json",
        })
      } catch {}
    }
  }

  return sessions
}

/**
 * Discover sessions across all configured providers (Claude, Cursor, Gemini, Codex).
 * Aggregates sessions from all available providers, sorted by mtime (most recent first).
 *
 * For Claude: queries ~/.claude/projects/<projectKey>/ for .jsonl files.
 * For Gemini: queries ~/.gemini/tmp/<bucket>/chats/session-*.json using .project_root metadata.
 *
 * @param projectDir - Project directory (used to compute Claude projectKey)
 * @returns Aggregated sessions from all providers, sorted by mtime descending
 */
export async function findAllProviderSessions(projectDir: string): Promise<Session[]> {
  const targetDir = resolve(projectDir)
  const claudeProjectDir = join(getProviderSessionDir("claude"), projectKeyFromCwd(targetDir))
  const [claudeSessions, geminiSessions] = await Promise.all([
    findSessions(claudeProjectDir),
    findGeminiSessions(targetDir),
  ])

  return [
    ...claudeSessions.map((s) => ({ ...s, provider: "claude" as const, format: "jsonl" as const })),
    ...geminiSessions,
  ].sort((a, b) => b.mtime - a.mtime)
}

// ─── Text extraction ─────────────────────────────────────────────────────────

export function extractText(content: string | ContentBlock[] | undefined): string {
  if (!content) return ""
  if (typeof content === "string") return content
  return content
    .filter((b): b is TextBlock => b.type === "text" && !!(b as TextBlock).text)
    .map((b) => b.text!)
    .join("\n")
    .trim()
}

export function isHookFeedback(content: string | ContentBlock[] | undefined): boolean {
  if (typeof content !== "string") return false
  return content.startsWith("Stop hook feedback:") || content.startsWith("<command-message>")
}

// ─── Plain turn extraction ───────────────────────────────────────────────────
// Produces simple {role, text} pairs from raw JSONL — shared by continue.ts
// and stop-auto-continue.ts where rendering details are not needed.

export interface PlainTurn {
  role: "user" | "assistant"
  text: string
}

function toolCallLabel(block: { name?: string; input?: Record<string, unknown> }): string {
  const name = block.name ?? "unknown"
  const input = block.input
  if (!input) return name

  const pathVal = input.path ?? input.file_path
  if (typeof pathVal === "string") return `${name}(${pathVal})`

  if (typeof input.command === "string") {
    const cmd = input.command.length > 80 ? `${input.command.slice(0, 77)}...` : input.command
    return `${name}(${cmd})`
  }

  if (typeof input.pattern === "string") return `${name}(${input.pattern})`
  if (typeof input.glob_pattern === "string") return `${name}(${input.glob_pattern})`
  if (typeof input.query === "string") {
    const q = input.query.length > 60 ? `${input.query.slice(0, 57)}...` : input.query
    return `${name}(${q})`
  }

  return name
}

const TOOL_RESULT_TRUNCATE = 400

export function extractToolResultText(block: {
  content?: string | ContentBlock[]
  is_error?: boolean
}): string {
  const c = block.content
  let text: string
  if (typeof c === "string") {
    text = c.trim()
  } else if (Array.isArray(c)) {
    text = c
      .filter((b: any) => b?.type === "text" && b?.text)
      .map((b: any) => String(b.text))
      .join("\n")
      .trim()
  } else {
    return ""
  }
  if (!text) return ""
  const prefix = block.is_error ? "Error: " : ""
  const truncated =
    text.length > TOOL_RESULT_TRUNCATE ? `${text.slice(0, TOOL_RESULT_TRUNCATE)}…` : text
  return `${prefix}${truncated}`
}

function summarizeToolCalls(content: unknown[]): string {
  const calls = content
    .filter((b: any) => b?.type === "tool_use" && b?.name)
    .map((b: any) => toolCallLabel(b))
  if (calls.length === 0) return ""
  return `[Tools: ${calls.join(", ")}]`
}

function parseJsonlEntries(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const line of text.split("\n").filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as TranscriptEntry
      if (parsed && typeof parsed === "object") entries.push(parsed)
    } catch {}
  }
  return entries
}

function extractGeminiText(content: unknown): string {
  if (typeof content === "string") return content.trim()

  if (Array.isArray(content)) {
    const texts = content
      .map((item) => {
        if (typeof item === "string") return item
        if (
          item &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>).text === "string"
        ) {
          return (item as Record<string, unknown>).text as string
        }
        return ""
      })
      .filter(Boolean)
    return texts.join("\n").trim()
  }

  if (content && typeof content === "object") {
    const obj = content as Record<string, unknown>
    if (typeof obj.text === "string") return obj.text.trim()
    if (Array.isArray(obj.parts)) {
      const texts = obj.parts
        .map((part) => {
          if (
            part &&
            typeof part === "object" &&
            typeof (part as Record<string, unknown>).text === "string"
          ) {
            return (part as Record<string, unknown>).text as string
          }
          return ""
        })
        .filter(Boolean)
      return texts.join("\n").trim()
    }
  }

  return ""
}

function parseGeminiEntries(text: string): TranscriptEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object") return []

  const record = parsed as Record<string, unknown>
  if (!Array.isArray(record.messages)) return []

  const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined
  const entries: TranscriptEntry[] = []

  for (const msg of record.messages) {
    if (!msg || typeof msg !== "object") continue
    const m = msg as Record<string, unknown>
    const rawType = typeof m.type === "string" ? m.type : typeof m.role === "string" ? m.role : ""
    const timestamp = typeof m.timestamp === "string" ? m.timestamp : undefined

    if (rawType === "info") continue

    if (rawType === "user") {
      const text = extractGeminiText(m.content)
      if (!text) continue
      entries.push({
        type: "user",
        sessionId,
        timestamp,
        message: {
          role: "user",
          content: text,
        },
      })
      continue
    }

    if (rawType === "gemini" || rawType === "assistant" || rawType === "model") {
      const blocks: ContentBlock[] = []
      const text = extractGeminiText(m.content)
      if (text) blocks.push({ type: "text", text })

      if (Array.isArray(m.toolCalls)) {
        for (const call of m.toolCalls) {
          if (!call || typeof call !== "object") continue
          const tool = call as Record<string, unknown>
          if (typeof tool.name !== "string" || !tool.name) continue
          const input =
            tool.args && typeof tool.args === "object" && !Array.isArray(tool.args)
              ? (tool.args as Record<string, unknown>)
              : {}
          blocks.push({ type: "tool_use", name: tool.name, input })
        }
      }

      if (blocks.length === 0) continue

      entries.push({
        type: "assistant",
        sessionId,
        timestamp,
        message: {
          role: "assistant",
          content: blocks,
        },
      })
    }
  }

  return entries
}

export function parseTranscriptEntries(
  text: string,
  formatHint?: Session["format"]
): TranscriptEntry[] {
  if (formatHint === "gemini-json") return parseGeminiEntries(text)
  if (formatHint === "jsonl") return parseJsonlEntries(text)

  const geminiEntries = parseGeminiEntries(text)
  if (geminiEntries.length > 0) return geminiEntries
  return parseJsonlEntries(text)
}

export function extractPlainTurns(transcriptText: string): PlainTurn[] {
  const turns: PlainTurn[] = []

  for (const entry of parseTranscriptEntries(transcriptText)) {
    if (entry?.type !== "user" && entry?.type !== "assistant") continue

    const content = entry?.message?.content
    if (!content) continue

    if (entry.type === "user" && isHookFeedback(content)) continue

    let text: string
    if (typeof content === "string") {
      text = content
    } else if (Array.isArray(content)) {
      text = content
        .filter((b): b is TextBlock => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n")

      const toolSummary = summarizeToolCalls(content)
      if (toolSummary) text = text ? `${text}\n${toolSummary}` : toolSummary

      if (entry.type === "user") {
        const resultTexts = content
          .filter((b: any) => b?.type === "tool_result")
          .map((b: any) => extractToolResultText(b))
          .filter(Boolean)
        if (resultTexts.length > 0) {
          const resultSummary = resultTexts.map((t) => `[Result: ${t}]`).join("\n")
          text = text ? `${text}\n${resultSummary}` : resultSummary
        }
      }
    } else {
      continue
    }

    text = text.trim()
    if (text) turns.push({ role: entry.type, text })
  }

  return turns
}

// ─── Tool call counting ──────────────────────────────────────────────────────

export function countToolCalls(jsonlText: string): number {
  let count = 0
  for (const entry of parseTranscriptEntries(jsonlText)) {
    if (entry?.type !== "assistant") continue
    const content = entry?.message?.content
    if (!Array.isArray(content)) continue
    count += content.filter((b: { type?: string }) => b?.type === "tool_use").length
  }
  return count
}

// ─── Context formatting ──────────────────────────────────────────────────────
// Formats plain turns into a labeled conversation string for LLM prompts.

export function formatTurnsAsContext(turns: PlainTurn[]): string {
  return turns
    .map(({ role, text }) => `${role === "user" ? "User" : "Assistant"}: ${text}`)
    .join("\n\n")
}
