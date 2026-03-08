import { open, readdir, readFile, stat } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { getHomeDir } from "./home.ts"
import { projectKeyFromCwd } from "./project-key.ts"
import { getDefaultTaskRoots } from "./task-roots.ts"

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
  provider?: "claude" | "gemini" | "antigravity" | "codex"
  format?: "jsonl" | "gemini-json" | "antigravity-pb" | "codex-jsonl"
}

export { projectKeyFromCwd }

const SESSION_PROVIDER_PRECEDENCE = ["claude", "gemini", "antigravity", "codex"] as const

function providerRank(provider: Session["provider"] | undefined): number {
  if (!provider) return SESSION_PROVIDER_PRECEDENCE.length
  const idx = SESSION_PROVIDER_PRECEDENCE.indexOf(provider)
  return idx === -1 ? SESSION_PROVIDER_PRECEDENCE.length : idx
}

function sortSessionsDeterministic(sessions: Session[]): Session[] {
  return sessions.sort(
    (a, b) =>
      b.mtime - a.mtime ||
      providerRank(a.provider) - providerRank(b.provider) ||
      a.id.localeCompare(b.id)
  )
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

  return sortSessionsDeterministic(sessions)
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

async function findGeminiSessions(targetDir: string, home?: string): Promise<Session[]> {
  home = home ?? getHomeDir()
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

const CODEX_SESSION_HEADER_BYTES = 262_144

async function readFilePrefix(
  path: string,
  maxBytes = CODEX_SESSION_HEADER_BYTES
): Promise<string> {
  let handle: import("node:fs/promises").FileHandle | null = null
  try {
    handle = await open(path, "r")
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead).toString("utf-8")
  } catch {
    return ""
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch {}
    }
  }
}

function parseCodexIdFromFilename(name: string): string {
  const base = name.replace(/\.(jsonl|json)$/i, "")
  const uuidMatch = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  return uuidMatch?.[0] ?? base
}

async function readCodexSessionMeta(
  sessionPath: string
): Promise<{ id: string | null; cwd: string | null }> {
  const prefix = await readFilePrefix(sessionPath)
  if (!prefix) return { id: null, cwd: null }

  let id: string | null = null
  let cwd: string | null = null

  for (const line of prefix.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }

    if (!parsed || typeof parsed !== "object") continue
    const record = parsed as Record<string, unknown>
    const type = record.type
    if (type !== "session_meta" && type !== "turn_context") continue

    const payload = record.payload
    if (!payload || typeof payload !== "object") continue
    const payloadRecord = payload as Record<string, unknown>

    const parsedId = payloadRecord.id
    if (!id && typeof parsedId === "string" && parsedId.trim()) {
      id = parsedId
    }

    const parsedCwd = payloadRecord.cwd
    if (!cwd && typeof parsedCwd === "string" && parsedCwd.trim()) {
      cwd = parsedCwd
    }

    if (id && cwd) break
  }

  return { id, cwd }
}

async function findCodexSessions(targetDir: string, home?: string): Promise<Session[]> {
  home = home ?? getHomeDir()
  const codexRoot = join(home, ".codex", "sessions")
  const targetPath = resolve(targetDir)
  const sessions: Session[] = []
  const pendingDirs = [codexRoot]

  while (pendingDirs.length > 0) {
    const current = pendingDirs.pop()!

    let entries: import("node:fs").Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const entryPath = join(current, entry.name)
      if (entry.isDirectory()) {
        pendingDirs.push(entryPath)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue

      const { id: parsedId, cwd } = await readCodexSessionMeta(entryPath)
      if (!cwd || resolve(cwd) !== targetPath) continue

      try {
        const s = await stat(entryPath)
        sessions.push({
          id: parsedId ?? parseCodexIdFromFilename(entry.name),
          path: entryPath,
          mtime: s.mtimeMs,
          provider: "codex",
          format: "codex-jsonl",
        })
      } catch {}
    }
  }

  return sessions
}

const ANTIGRAVITY_PROJECT_HINT_FILES = new Set([
  "task.md",
  "task.md.resolved",
  "task.md.resolved.0",
  "implementation_plan.md",
  "implementation_plan.md.resolved",
  "implementation_plan.md.resolved.0",
  "walkthrough.md",
  "walkthrough.md.resolved",
  "walkthrough.md.resolved.0",
])

async function antigravitySessionMatchesTarget(
  brainSessionDir: string,
  targetDir: string
): Promise<boolean> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(brainSessionDir, { withFileTypes: true })
  } catch {
    // If no metadata can be read, include as fallback so users can still resolve by ID.
    return true
  }

  const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
  const preferred = fileNames.filter((name) => ANTIGRAVITY_PROJECT_HINT_FILES.has(name))
  const fallback = fileNames
    .filter(
      (name) => name.endsWith(".md") || name.endsWith(".resolved") || name.endsWith(".resolved.0")
    )
    .slice(0, 5)

  const candidates = [...new Set([...preferred, ...fallback])].slice(0, 8)
  if (candidates.length === 0) return true

  const targetPath = resolve(targetDir)
  const fileUrlNeedle = `file://${targetPath}`

  for (const name of candidates) {
    try {
      const content = await readFile(join(brainSessionDir, name), "utf-8")
      const sample = content.slice(0, 200_000)
      if (sample.includes(fileUrlNeedle) || sample.includes(targetPath)) {
        return true
      }
    } catch {}
  }

  return false
}

async function findAntigravitySessions(targetDir: string, home?: string): Promise<Session[]> {
  home = home ?? getHomeDir()
  const antigravityRoot = join(home, ".gemini", "antigravity")
  const conversationsDir = join(antigravityRoot, "conversations")
  const brainDir = join(antigravityRoot, "brain")
  const sessions: Session[] = []

  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(conversationsDir, { withFileTypes: true })
  } catch {
    return []
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith(".pb")) continue

    const id = entry.name.replace(/\.pb$/, "")
    const sessionPath = join(conversationsDir, entry.name)
    const brainSessionDir = join(brainDir, id)
    const matchesTarget = await antigravitySessionMatchesTarget(brainSessionDir, targetDir)
    if (!matchesTarget) continue

    try {
      const s = await stat(sessionPath)
      sessions.push({
        id,
        path: sessionPath,
        mtime: s.mtimeMs,
        provider: "antigravity",
        format: "antigravity-pb",
      })
    } catch {}
  }

  return sessions
}

/**
 * Discover sessions across supported transcript providers (Claude, Gemini, Antigravity, Codex).
 * Aggregates sessions from all available providers, sorted by mtime (most recent first) with
 * deterministic tie-breaking by provider precedence (Claude > Gemini > Antigravity > Codex).
 *
 * For Claude: queries ~/.claude/projects/<projectKey>/ for .jsonl files.
 * For Gemini: queries ~/.gemini/tmp/<bucket>/chats/session-*.json using .project_root metadata.
 * For Antigravity: queries ~/.gemini/antigravity/conversations/*.pb and maps by brain metadata.
 * For Codex: recursively queries ~/.codex/sessions/<year>/<month>/<day>/*.jsonl using
 * session_meta payload cwd metadata.
 *
 * @param projectDir - Project directory (used to compute Claude projectKey)
 * @returns Aggregated sessions from all providers, sorted by mtime descending
 */
export async function findAllProviderSessions(
  projectDir: string,
  home?: string
): Promise<Session[]> {
  const targetDir = resolve(projectDir)
  const effectiveHome = home ?? getHomeDir()
  const { projectsDir } = getDefaultTaskRoots(effectiveHome)
  const claudeProjectDir = join(projectsDir, projectKeyFromCwd(targetDir))
  const [claudeSessions, geminiSessions, antigravitySessions, codexSessions] = await Promise.all([
    findSessions(claudeProjectDir),
    findGeminiSessions(targetDir, effectiveHome),
    findAntigravitySessions(targetDir, effectiveHome),
    findCodexSessions(targetDir, effectiveHome),
  ])

  const merged: Session[] = [
    ...claudeSessions.map((s) => ({ ...s, provider: "claude" as const, format: "jsonl" as const })),
    ...geminiSessions,
    ...antigravitySessions,
    ...codexSessions,
  ]
  return sortSessionsDeterministic(merged)
}

export function isUnsupportedTranscriptFormat(format: Session["format"] | undefined): boolean {
  return format === "antigravity-pb"
}

export function getUnsupportedTranscriptFormatMessage(session: Session): string {
  if (session.format !== "antigravity-pb") return ""
  return (
    `Session ${session.id} is stored in Antigravity protobuf format (.pb), ` +
    "which swiz cannot decode yet. Use --list to choose a Claude/Gemini session."
  )
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

export function buildTaskSection(taskContext: string): string {
  if (!taskContext) return ""
  return `=== SESSION TASKS ===\n${taskContext}\n=== END OF SESSION TASKS ===\n\n`
}

export function buildUserMessagesSection(turns: PlainTurn[]): string {
  const userTurns = turns.filter((t) => t.role === "user")
  if (userTurns.length === 0) return ""
  return `=== USER'S MESSAGES ===\n${userTurns.map((t) => `- ${t.text}`).join("\n\n")}\n=== END OF USER'S MESSAGES ===\n\n`
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

function extractCodexMessageText(content: unknown, textType: "input_text" | "output_text"): string {
  if (!Array.isArray(content)) return ""
  const texts = content
    .map((part) => {
      if (!part || typeof part !== "object") return ""
      const block = part as Record<string, unknown>
      if (block.type !== textType) return ""
      return typeof block.text === "string" ? block.text : ""
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
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return normalize(parsed as Record<string, unknown>)
    }
  } catch {}
  return {}
}

function parseCodexJsonlEntries(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  let sessionId: string | undefined

  for (const line of text.split("\n").filter(Boolean)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== "object") continue

    const record = parsed as Record<string, unknown>
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined

    if (record.type === "session_meta" && record.payload && typeof record.payload === "object") {
      const payload = record.payload as Record<string, unknown>
      const parsedId = payload.id
      if (typeof parsedId === "string" && parsedId.trim()) {
        sessionId = parsedId
      }
      continue
    }

    if (record.type === "event_msg" && record.payload && typeof record.payload === "object") {
      const payload = record.payload as Record<string, unknown>
      if (payload.type === "user_message" && typeof payload.message === "string") {
        const message = payload.message.trim()
        if (!message) continue
        entries.push({
          type: "user",
          sessionId,
          timestamp,
          message: {
            role: "user",
            content: message,
          },
        })
      }
      continue
    }

    if (record.type !== "response_item" || !record.payload || typeof record.payload !== "object") {
      continue
    }

    const payload = record.payload as Record<string, unknown>
    if (payload.type === "message" && payload.role === "assistant") {
      const text = extractCodexMessageText(payload.content, "output_text")
      if (!text) continue
      entries.push({
        type: "assistant",
        sessionId,
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
        },
      })
      continue
    }

    if (payload.type === "function_call" && typeof payload.name === "string" && payload.name) {
      entries.push({
        type: "assistant",
        sessionId,
        timestamp,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: payload.name,
              input: parseCodexToolInput(payload.arguments),
            },
          ],
        },
      })
    }
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
  if (formatHint === "antigravity-pb") return []
  if (formatHint === "gemini-json") return parseGeminiEntries(text)
  if (formatHint === "codex-jsonl") return parseCodexJsonlEntries(text)
  if (formatHint === "jsonl") return parseJsonlEntries(text)

  const geminiEntries = parseGeminiEntries(text)
  if (geminiEntries.length > 0) return geminiEntries
  const codexEntries = parseCodexJsonlEntries(text)
  if (codexEntries.length > 0) return codexEntries
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
