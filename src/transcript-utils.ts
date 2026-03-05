import { existsSync } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { AGENTS } from "./agents.ts"
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

/**
 * Discover sessions across all configured providers (Claude, Cursor, Gemini, Codex).
 * Aggregates sessions from all available providers, sorted by mtime (most recent first).
 *
 * For Claude: queries ~/.claude/projects/<projectKey>/ for .jsonl files
 * For other providers: queries their session directories for .jsonl files
 *
 * @param projectDir - Project directory (used to compute Claude projectKey)
 * @returns Aggregated sessions from all providers, sorted by mtime descending
 */
export async function findAllProviderSessions(projectDir: string): Promise<Session[]> {
  const allSessions: Session[] = []

  for (const agent of AGENTS) {
    try {
      let sessionDir = ""

      if (agent.id === "claude") {
        // Claude stores sessions under ~/.claude/projects/<projectKey>/
        const projectKey = projectKeyFromCwd(projectDir)
        sessionDir = join(getProviderSessionDir(agent), projectKey)
      } else {
        // Other providers store sessions in their root directory
        sessionDir = getProviderSessionDir(agent)
      }

      // Skip if directory doesn't exist
      if (!existsSync(sessionDir)) continue

      // Read sessions from this provider's directory
      let entries: string[]
      try {
        entries = await readdir(sessionDir)
      } catch {
        continue
      }

      for (const entry of entries) {
        // For now, all providers use .jsonl format (Claude's pattern)
        // Future: handle provider-specific formats (Cursor, Gemini, Codex)
        if (!entry.endsWith(".jsonl")) continue

        const id = entry.slice(0, -6)
        const filePath = join(sessionDir, entry)

        try {
          const s = await stat(filePath)
          allSessions.push({ id, path: filePath, mtime: s.mtimeMs })
        } catch {}
      }
    } catch {}
  }

  return allSessions.sort((a, b) => b.mtime - a.mtime)
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

export function extractPlainTurns(jsonlText: string): PlainTurn[] {
  const turns: PlainTurn[] = []

  for (const line of jsonlText.split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(line)
      if (entry?.type !== "user" && entry?.type !== "assistant") continue

      const content = entry?.message?.content
      if (!content) continue

      if (entry.type === "user" && isHookFeedback(content)) continue

      let text: string
      if (typeof content === "string") {
        text = content
      } else if (Array.isArray(content)) {
        text = content
          .filter((b: { type?: string; text?: string }) => b?.type === "text" && b?.text)
          .map((b: { text?: string }) => b.text!)
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
    } catch {}
  }

  return turns
}

// ─── Tool call counting ──────────────────────────────────────────────────────

export function countToolCalls(jsonlText: string): number {
  let count = 0
  for (const line of jsonlText.split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(line)
      if (entry?.type !== "assistant") continue
      const content = entry?.message?.content
      if (!Array.isArray(content)) continue
      count += content.filter((b: { type?: string }) => b?.type === "tool_use").length
    } catch {}
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
