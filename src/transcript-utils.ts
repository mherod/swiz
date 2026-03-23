import { open, readdir, readFile, stat } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { z } from "zod"
import { GIT_GLOBAL_OPTS } from "../hooks/utils/shell-patterns.ts"
import { getHomeDir } from "./home.ts"
import { projectKeyFromCwd } from "./project-key.ts"
import { createDefaultTaskStore } from "./task-roots.ts"

// ─── Content block Zod schemas ────────────────────────────────────────────────

/**
 * Zod schemas for content blocks in transcript messages.
 * Use `contentBlockSchema.safeParse()` for type-safe validation instead of
 * manual `typeof` checks and `as { ... }` casts.
 */

/** Schema for text content blocks: `{ type: "text", text?: string }` */
export const textBlockSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string().optional(),
})

/** Schema for tool_use blocks: `{ type: "tool_use", id?, name?, input? }` */
export const toolUseBlockSchema = z.looseObject({
  type: z.literal("tool_use"),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
})

/** Schema for tool_result blocks: `{ type: "tool_result", tool_use_id?, content?, is_error? }` */
export const toolResultBlockSchema: z.ZodType<{
  type: "tool_result"
  tool_use_id?: string
  content?: string | unknown[]
  is_error?: boolean
  [k: string]: unknown
}> = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string().optional(),
  is_error: z.boolean().optional(),
})

/** Catch-all schema for unknown content block types */
export const unknownBlockSchema = z.looseObject({
  type: z.string(),
})

/**
 * Content block schema — union of known block types with catch-all fallback.
 * Validates against known block types (text, tool_use, tool_result) and
 * falls back to catch-all for unknown types.
 *
 * Note: Uses `z.union()` instead of `z.discriminatedUnion()` because the
 * catch-all schema uses `z.string()` (non-literal) for the type field.
 *
 * @example
 * const result = contentBlockSchema.safeParse(block)
 * if (result.success && result.data.type === "tool_use") {
 *   // TypeScript knows result.data has name, input, etc.
 * }
 */
export const contentBlockSchema = z.union([
  textBlockSchema,
  toolUseBlockSchema,
  toolResultBlockSchema,
  unknownBlockSchema,
])

/** Type guard: checks if value is a valid content block */
export function isContentBlock(value: unknown): value is ContentBlock {
  return contentBlockSchema.safeParse(value).success
}

/** Type guard: checks if value is a valid text block with a string `text` field */
export function isTextBlockWithText(value: unknown): value is { type: "text"; text: string } {
  const result = textBlockSchema.safeParse(value)
  return result.success && typeof result.data.text === "string"
}

// ─── Content block TypeScript interfaces (derived from schemas) ───────────────

export type TextBlock = z.infer<typeof textBlockSchema>
export type ToolUseBlock = z.infer<typeof toolUseBlockSchema>
export type ToolResultBlock = z.infer<typeof toolResultBlockSchema>
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
  provider?: "claude" | "gemini" | "cursor" | "antigravity" | "codex"
  format?:
    | "jsonl"
    | "gemini-json"
    | "cursor-sqlite"
    | "antigravity-pb"
    | "codex-jsonl"
    | "cursor-agent-jsonl"
}

export interface TranscriptResolution {
  raw: string | null
  sourceDescription: string
  formatHint?: Session["format"]
  failureReason?: string
}

export { projectKeyFromCwd }

const SESSION_PROVIDER_PRECEDENCE = ["claude", "gemini", "cursor", "antigravity", "codex"] as const

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

async function collectGeminiChatSessions(chatsDir: string, sessions: Session[]): Promise<void> {
  let chatEntries: import("node:fs").Dirent[]
  try {
    chatEntries = await readdir(chatsDir, { withFileTypes: true })
  } catch {
    return
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

async function matchesBucketTarget(
  bucketDir: string,
  geminiHistory: string,
  bucketName: string,
  target: string,
  fallbackName: string
): Promise<boolean> {
  const roots = new Set<string>()
  const tmpRoot = await readProjectRoot(join(bucketDir, ".project_root"))
  if (tmpRoot) roots.add(tmpRoot)
  const historyRoot = await readProjectRoot(join(geminiHistory, bucketName, ".project_root"))
  if (historyRoot) roots.add(historyRoot)
  return roots.size > 0 ? [...roots].some((root) => root === target) : bucketName === fallbackName
}

async function findGeminiSessions(targetDir: string, home?: string): Promise<Session[]> {
  home = home ?? getHomeDir()
  const geminiTmp = join(home, ".gemini", "tmp")
  const geminiHistory = join(home, ".gemini", "history")
  const target = resolve(targetDir)
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
    const matches = await matchesBucketTarget(
      bucketDir,
      geminiHistory,
      bucket.name,
      target,
      basename(target)
    )
    if (!matches) continue
    await collectGeminiChatSessions(join(bucketDir, "chats"), sessions)
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

const CODEX_META_TYPES = new Set(["session_meta", "turn_context"])

function extractCodexMetaPayload(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed) as unknown
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const record = parsed as Record<string, unknown>
  if (!CODEX_META_TYPES.has(record.type as string)) return null
  const payload = record.payload
  if (!payload || typeof payload !== "object") return null
  return payload as Record<string, unknown>
}

async function readCodexSessionMeta(
  sessionPath: string
): Promise<{ id: string | null; cwd: string | null }> {
  const prefix = await readFilePrefix(sessionPath)
  if (!prefix) return { id: null, cwd: null }

  let id: string | null = null
  let cwd: string | null = null

  for (const line of prefix.split("\n")) {
    const payload = extractCodexMetaPayload(line)
    if (!payload) continue

    if (!id && typeof payload.id === "string" && payload.id.trim()) id = payload.id as string
    if (!cwd && typeof payload.cwd === "string" && payload.cwd.trim()) cwd = payload.cwd as string
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

async function cursorSessionMatchesTarget(
  sessionPath: string,
  targetDir: string
): Promise<boolean> {
  const targetPath = resolve(targetDir)
  const fileUrlNeedle = `file://${targetPath}`
  try {
    const text = await Bun.file(sessionPath).text()
    return text.includes(targetPath) || text.includes(fileUrlNeedle)
  } catch {
    return false
  }
}

async function findCursorSessions(targetDir: string, home?: string): Promise<Session[]> {
  home = home ?? getHomeDir()
  const chatsRoot = join(home, ".cursor", "chats")
  const sessions: Session[] = []

  let workspaceEntries: import("node:fs").Dirent[]
  try {
    workspaceEntries = await readdir(chatsRoot, { withFileTypes: true })
  } catch {
    return []
  }

  for (const workspaceEntry of workspaceEntries) {
    if (!workspaceEntry.isDirectory()) continue
    const workspaceDir = join(chatsRoot, workspaceEntry.name)

    let sessionEntries: import("node:fs").Dirent[]
    try {
      sessionEntries = await readdir(workspaceDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue
      const sessionDir = join(workspaceDir, sessionEntry.name)
      const sessionPath = join(sessionDir, "store.db")

      try {
        const s = await stat(sessionPath)
        if (!s.isFile()) continue
      } catch {
        continue
      }

      const matchesTarget = await cursorSessionMatchesTarget(sessionPath, targetDir)
      if (!matchesTarget) continue

      try {
        const s = await stat(sessionPath)
        sessions.push({
          id: sessionEntry.name,
          path: sessionPath,
          mtime: s.mtimeMs,
          provider: "cursor",
          format: "cursor-sqlite",
        })
      } catch {}
    }
  }

  return sessions
}

function cursorProjectKeyCandidates(targetDir: string): Set<string> {
  const key = projectKeyFromCwd(resolve(targetDir))
  const withoutLeadingDashes = key.replace(/^-+/, "")
  return new Set([key, withoutLeadingDashes])
}

async function collectCursorSessionFiles(sessionDir: string, sessions: Session[]): Promise<void> {
  let files: import("node:fs").Dirent[]
  try {
    files = await readdir(sessionDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".jsonl")) continue
    const sessionPath = join(sessionDir, file.name)
    try {
      const s = await stat(sessionPath)
      sessions.push({
        id: file.name.replace(/\.jsonl$/, ""),
        path: sessionPath,
        mtime: s.mtimeMs,
        provider: "cursor",
        format: "cursor-agent-jsonl",
      })
    } catch {}
  }
}

async function collectCursorTranscriptSessions(
  transcriptRoot: string,
  sessions: Session[]
): Promise<void> {
  let transcriptEntries: import("node:fs").Dirent[]
  try {
    transcriptEntries = await readdir(transcriptRoot, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of transcriptEntries) {
    if (!entry.isDirectory()) continue
    await collectCursorSessionFiles(join(transcriptRoot, entry.name), sessions)
  }
}

async function findCursorAgentTranscriptSessions(
  targetDir: string,
  home?: string
): Promise<Session[]> {
  home = home ?? getHomeDir()
  const projectsRoot = join(home, ".cursor", "projects")
  const keyCandidates = cursorProjectKeyCandidates(targetDir)
  const sessions: Session[] = []

  let projectEntries: import("node:fs").Dirent[]
  try {
    projectEntries = await readdir(projectsRoot, { withFileTypes: true })
  } catch {
    return []
  }

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue
    if (!keyCandidates.has(projectEntry.name)) continue
    const transcriptRoot = join(projectsRoot, projectEntry.name, "agent-transcripts")
    await collectCursorTranscriptSessions(transcriptRoot, sessions)
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
 * Discover sessions across supported transcript providers (Claude, Gemini, Cursor, Antigravity, Codex).
 * Aggregates sessions from all available providers, sorted by mtime (most recent first) with
 * deterministic tie-breaking by provider precedence (Claude > Gemini > Cursor > Antigravity > Codex).
 *
 * For Claude: queries ~/.claude/projects/<projectKey>/ for .jsonl files.
 * For Gemini: queries ~/.gemini/tmp/<bucket>/chats/session-*.json using .project_root metadata.
 * For Cursor: queries ~/.cursor/chats/<workspace-hash>/<session-id>/store.db and
 * ~/.cursor/projects/<project-key>/agent-transcripts/<session-id>/*.jsonl.
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
  const { projectsDir } = createDefaultTaskStore(effectiveHome)
  const claudeProjectDir = join(projectsDir, projectKeyFromCwd(targetDir))
  const [
    claudeSessions,
    geminiSessions,
    cursorSessions,
    cursorAgentSessions,
    antigravitySessions,
    codexSessions,
  ] = await Promise.all([
    findSessions(claudeProjectDir),
    findGeminiSessions(targetDir, effectiveHome),
    findCursorSessions(targetDir, effectiveHome),
    findCursorAgentTranscriptSessions(targetDir, effectiveHome),
    findAntigravitySessions(targetDir, effectiveHome),
    findCodexSessions(targetDir, effectiveHome),
  ])

  const merged: Session[] = [
    ...claudeSessions.map((s) => ({ ...s, provider: "claude" as const, format: "jsonl" as const })),
    ...geminiSessions,
    ...cursorSessions,
    ...cursorAgentSessions,
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

function inferTranscriptFormatFromPath(path: string): Session["format"] | undefined {
  const lowerPath = path.toLowerCase()
  if (lowerPath.endsWith(".db")) return "cursor-sqlite"
  if (lowerPath.includes("/.codex/sessions/") && lowerPath.endsWith(".jsonl")) return "codex-jsonl"
  if (lowerPath.includes("/.cursor/projects/") && lowerPath.endsWith(".jsonl")) {
    return "cursor-agent-jsonl"
  }
  if (lowerPath.endsWith(".jsonl")) return "jsonl"
  return undefined
}

async function tryInputTranscript(
  transcriptPath: string
): Promise<
  { resolution: TranscriptResolution; status: "ok" } | { status: "unreadable" | "unparseable" }
> {
  const hintedFormat = inferTranscriptFormatFromPath(transcriptPath)
  try {
    const raw = await Bun.file(transcriptPath).text()
    const hintedTurns = extractTranscriptData(raw, hintedFormat).turns.length
    const fallbackTurns = hintedFormat ? extractTranscriptData(raw).turns.length : 0
    if (hintedTurns > 0 || fallbackTurns > 0) {
      return {
        status: "ok",
        resolution: {
          raw,
          sourceDescription: `stop hook input transcript_path (${transcriptPath})`,
          formatHint: hintedTurns > 0 ? hintedFormat : undefined,
        },
      }
    }
    return { status: "unparseable" }
  } catch {
    return { status: "unreadable" }
  }
}

async function findFallbackTranscript(
  sessions: Session[]
): Promise<{ first: TranscriptResolution | null; match: TranscriptResolution | null }> {
  let first: TranscriptResolution | null = null
  for (const session of sessions) {
    if (isUnsupportedTranscriptFormat(session.format)) continue
    try {
      const raw = await Bun.file(session.path).text()
      const resolution: TranscriptResolution = {
        raw,
        formatHint: session.format,
        sourceDescription: `${session.provider ?? "unknown"} session ${session.id} (${session.path})`,
      }
      if (!first) first = resolution
      if (extractTranscriptData(raw, session.format).turns.length > 0) {
        return { first, match: resolution }
      }
    } catch {
      // Try the next candidate.
    }
  }
  return { first, match: null }
}

function buildTranscriptFailureReason(
  sessions: Session[],
  transcriptPath: string | undefined,
  inputStatus: "unreadable" | "unparseable" | null,
  cwd: string
): string {
  const unsupported = sessions.find((session) => isUnsupportedTranscriptFormat(session.format))
  const unsupportedMessage = unsupported ? getUnsupportedTranscriptFormatMessage(unsupported) : ""
  const inputFailure =
    inputStatus === "unreadable"
      ? `Input transcript ${transcriptPath} could not be read.`
      : inputStatus === "unparseable"
        ? `Input transcript ${transcriptPath} had no parseable turns.`
        : ""
  const failureReasonBase = unsupportedMessage
    ? `${unsupportedMessage} No readable fallback transcript was found for cwd ${cwd}.`
    : `No readable transcript was found from stop hook input or cwd fallback sessions for ${cwd}.`
  return [inputFailure, failureReasonBase].filter(Boolean).join(" ")
}

export async function resolveTranscriptText(
  transcriptPath: string | undefined,
  cwd: string,
  home?: string
): Promise<TranscriptResolution> {
  let inputStatus: "unreadable" | "unparseable" | null = null

  if (transcriptPath?.trim()) {
    const result = await tryInputTranscript(transcriptPath)
    if (result.status === "ok") return result.resolution
    inputStatus = result.status
  }

  const sessions = await findAllProviderSessions(cwd, home)
  const { first, match } = await findFallbackTranscript(sessions)
  if (match) return match

  if (first) {
    return {
      ...first,
      failureReason:
        inputStatus === "unparseable"
          ? `Input transcript ${transcriptPath} had no parseable turns; using best readable fallback transcript.`
          : undefined,
    }
  }

  return {
    raw: null,
    sourceDescription: "none",
    failureReason: buildTranscriptFailureReason(sessions, transcriptPath, inputStatus, cwd),
  }
}

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
    try {
      const text = extractTextFromEntry(JSON.parse(line))
      if (text) return text
    } catch {
      // skip malformed lines
    }
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

/**
 * Returns the block reason text if the most recent stop-hook feedback in the
 * transcript carried `resolution: "human-required"`, otherwise null.
 *
 * Detection: scan the last `limit` entries for a user-role `<command-message>`
 * turn whose content includes the sentinel injected by `blockStopHumanRequired`.
 * A human-required block from any earlier session turn is considered stale once
 * a newer non-hook-feedback assistant turn appears after it.
 */
function extractContentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
}

function extractCommandMessage(text: string, sentinel: string): string | null {
  if (!text.startsWith("<command-message>") || !text.includes(sentinel)) return null
  return text
    .replace(/^<command-message>\s*/i, "")
    .replace(/<\/command-message>\s*$/i, "")
    .trim()
}

export function findHumanRequiredBlock(transcriptText: string, limit = 20): string | null {
  const entries: Array<{ type?: string; message?: { role?: string; content?: unknown } }> = []
  for (const entry of parseTranscriptEntries(transcriptText)) {
    entries.push(entry)
  }
  const recent = entries.slice(-limit)
  for (let i = recent.length - 1; i >= 0; i--) {
    const entry = recent[i]!
    if (entry.type === "assistant") return null
    if (entry.type === "user") {
      const text = extractContentText(entry.message?.content)
      const result = extractCommandMessage(text, "ACTION REQUIRED:")
      if (result) return result
    }
  }
  return null
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

function isToolUseSummaryBlock(block: unknown): block is {
  type: "tool_use"
  name: string
  input?: Record<string, unknown>
} {
  const result = toolUseBlockSchema.safeParse(block)
  return result.success && typeof result.data.name === "string"
}

function isToolResultSummaryBlock(block: unknown): block is {
  type: "tool_result"
  content?: string | ContentBlock[]
  is_error?: boolean
} {
  return toolResultBlockSchema.safeParse(block).success
}

function summarizeToolCalls(content: unknown[]): string {
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

function parseJsonlEntries(text: string): TranscriptEntry[] {
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
    sessionId = classifyCodexLine(parsed, sessionId, entries)
  }

  return entries
}

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

    const obj = content as Record<string, unknown>
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
        ? (toolResult.data.args as Record<string, unknown>)
        : {}
    blocks.push({ type: "tool_use", name: toolResult.data.name, input })
  }
  return blocks
}

function classifyGeminiRole(m: Record<string, unknown>): string {
  if (typeof m.type === "string") return m.type
  if (typeof m.role === "string") return m.role
  return ""
}

const GEMINI_ASSISTANT_ROLES = new Set(["gemini", "assistant", "model"])

function classifyGeminiMessage(
  m: Record<string, unknown>,
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
    classifyGeminiMessage(msg as Record<string, unknown>, sessionId, entries)
  }

  return entries
}

function findMatchingBrace(text: string, startIndex: number): number {
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i]
    if (!ch) continue

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === "\\") {
        escaped = true
        continue
      }
      if (ch === '"') inString = false
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

function parseJsonObjectAt(text: string, startIndex: number): Record<string, unknown> | null {
  if (text[startIndex] !== "{") return null
  const endIndex = findMatchingBrace(text, startIndex)
  if (endIndex < 0) return null
  try {
    const parsed = JSON.parse(text.slice(startIndex, endIndex + 1)) as Record<string, unknown>
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

function normalizeCursorContent(content: unknown): string | ContentBlock[] {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  const blocks: ContentBlock[] = []
  for (const item of content) {
    const textResult = cursorTextBlockSchema.safeParse(item)
    if (textResult.success) {
      blocks.push({ type: "text", text: textResult.data.text })
      continue
    }

    const toolCallResult = cursorToolCallBlockSchema.safeParse(item)
    if (toolCallResult.success) {
      const input =
        toolCallResult.data.params &&
        typeof toolCallResult.data.params === "object" &&
        !Array.isArray(toolCallResult.data.params)
          ? (toolCallResult.data.params as Record<string, unknown>)
          : {}
      blocks.push({ type: "tool_use", name: toolCallResult.data.toolName, input })
      continue
    }

    const toolResultResult = cursorToolResultBlockSchema.safeParse(item)
    if (toolResultResult.success) {
      const resultText = extractTextFromUnknownContent(toolResultResult.data.result)
      if (resultText) {
        blocks.push({ type: "tool_result", content: [{ type: "text", text: resultText }] })
      }
    }
  }

  return blocks
}

const CURSOR_ROLES = new Set(["user", "assistant", "tool"])

function classifyCursorObject(obj: Record<string, unknown>, entries: TranscriptEntry[]): void {
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

export function parseTranscriptEntries(
  text: string,
  formatHint?: Session["format"]
): TranscriptEntry[] {
  if (formatHint === "antigravity-pb") return []
  if (formatHint === "cursor-sqlite") return parseCursorSqliteEntries(text)
  if (formatHint === "cursor-agent-jsonl") return parseJsonlEntries(text)
  if (formatHint === "gemini-json") return parseGeminiEntries(text)
  if (formatHint === "codex-jsonl") return parseCodexJsonlEntries(text)
  if (formatHint === "jsonl") return parseJsonlEntries(text)

  if (text.startsWith("SQLite format 3")) {
    const cursorEntries = parseCursorSqliteEntries(text)
    if (cursorEntries.length > 0) return cursorEntries
  }

  const geminiEntries = parseGeminiEntries(text)
  if (geminiEntries.length > 0) return geminiEntries
  const codexEntries = parseCodexJsonlEntries(text)
  if (codexEntries.length > 0) return codexEntries
  return parseJsonlEntries(text)
}

function buildArrayContentText(content: unknown[], entryType: string): string {
  let text = content
    .filter(isTextBlockWithText)
    .map((b) => b.text)
    .join("\n")

  const toolSummary = summarizeToolCalls(content)
  if (toolSummary) text = text ? `${text}\n${toolSummary}` : toolSummary

  if (entryType === "user") {
    const resultTexts = content
      .filter(isToolResultSummaryBlock)
      .map((b) => extractToolResultText(b))
      .filter(Boolean)
    if (resultTexts.length > 0) {
      const resultSummary = resultTexts.map((t) => `[Result: ${t}]`).join("\n")
      text = text ? `${text}\n${resultSummary}` : resultSummary
    }
  }

  return text
}

function extractEntryText(content: unknown, entryType: string): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return buildArrayContentText(content, entryType)
  return ""
}

export function extractPlainTurns(transcriptText: string): PlainTurn[] {
  const turns: PlainTurn[] = []

  for (const entry of parseTranscriptEntries(transcriptText)) {
    const entryType = entry?.type
    if (entryType !== "user" && entryType !== "assistant") continue
    const content = entry.message?.content
    if (!content) continue
    if (entryType === "user" && isHookFeedback(content)) continue

    const text = extractEntryText(content, entryType).trim()
    if (text) turns.push({ role: entryType, text })
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

// ─── Edited file path extraction ─────────────────────────────────────────────

// Matches file-modifying shell commands and captures path arguments.
// Covers: trash <path>, rm <path>, mv <src> <dst>, cp <src> <dst>,
// ln [-s|-f] <src> <dst>, link <src> <dst>,
// git mv <src> <dst>, git rm <path>.
// Paths may be quoted (single or double) or unquoted.
const SHELL_FILE_MOD_RE =
  /(?:^|[|;&\s])(?:trash\s+|rm\s+(?:-[rfRF]+\s+)*|mv\s+|cp\s+|ln\s+(?:-\S+\s+)*|link\s+|git\s+(?:mv|rm)\s+)((?:"[^"]*"|'[^']*'|[^\s|;&"']+)(?:\s+(?:"[^"]*"|'[^']*'|[^\s|;&"']+))*)/gm

// Matches output redirections that write to a file: > file or >> file.
// Excludes: >& (fd dup), >( (process substitution), >&- (close fd).
// Captures the target path (quoted or unquoted).
const REDIRECT_WRITE_RE = />>?(?![&(])\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s|;&"'>]+)/gm

// Matches sed -i (in-place edit): sed -i[.suffix] 's/.../.../' <file> ...
// Handles: -i (GNU), -i.bak (attached suffix), -i '' (BSD empty suffix).
// Captures all path tokens after the script argument.
const SED_INPLACE_RE =
  /(?:^|[|;&\s])sed\s+(?:-[a-zA-Z]*i(?:\.[^\s]*)?\s+(?:''|"")?\s?|--in-place(?:=\S+)?\s+)(?:'[^']*'|"[^"]*"|\S+)\s+((?:"[^"]*"|'[^']*'|[^\s|;&"']+)(?:\s+(?:"[^"]*"|'[^']*'|[^\s|;&"']+))*)/gm

// Matches tee command file targets: tee [-a] [--] <file> [file2 ...]
// Excludes process substitution targets >(cmd).
const TEE_RE =
  /(?:^|[|;&\s])tee\s+(?:-a\s+|--\s+)?((?:"[^"]*"|'[^']*'|[^\s|;&"'>(][^\s|;&"']*)(?:\s+(?:"[^"]*"|'[^']*'|[^\s|;&"'>(][^\s|;&"']*))*)/gm

// Matches touch, truncate, mkdir, and rmdir file/directory targets.
// touch [-t] <file> [file2 ...], truncate [-s size] <file>,
// mkdir [-p] [-m mode] <dir> [dir2 ...], rmdir [-p] <dir> [dir2 ...].
const TOUCH_TRUNCATE_INSTALL_RE =
  /(?:^|[|;&\s])(?:touch|truncate|mkdir|rmdir)\s+(?:-\S+\s+)*((?:"[^"]*"|'[^']*'|[^\s|;&"']+)(?:\s+(?:"[^"]*"|'[^']*'|[^\s|;&"']+))*)/gm

// Matches chmod and chown file targets: chmod [-R] <mode> <file> [file2 ...]
// and chown [-R] <owner>[:<group>] <file> [file2 ...].
// The first non-flag argument (mode or owner spec) is NOT a path — captured in group 1.
// Path arguments follow in group 2 (one or more, quoted or unquoted).
const CHMOD_CHOWN_RE =
  /(?:^|[|;&\s])(?:chmod|chown)\s+(?:-\S+\s+)*(?:"[^"]*"|'[^']*'|[^\s|;&"']+)\s+((?:"[^"]*"|'[^']*'|[^\s|;&"']+)(?:\s+(?:"[^"]*"|'[^']*'|[^\s|;&"']+))*)/gm

// Matches install command positional file targets: install [-m mode] [-o owner] [-g group] src... dest
// Flags with values (-m 755, -o root, -g wheel, -S suffix) are consumed by the prefix;
// remaining tokens include source and destination paths.
// Note: -t / --target-directory destination is handled separately by INSTALL_TARGET_DIR_RE.
const INSTALL_CMD_RE =
  /(?:^|[|;&\s])install\s+(?:(?:-[mogtS]\s+\S+|-\S+)\s+)*((?:"[^"]*"|'[^']*'|[^\s|;&"']+)(?:\s+(?:"[^"]*"|'[^']*'|[^\s|;&"']+))*)/gm

// Extracts the destination directory from install -t <dir> or install --target-directory=<dir>.
// Group 1 captures the -t value; group 2 captures the --target-directory= value.
const INSTALL_TARGET_DIR_RE =
  /(?:^|[|;&\s])install\b[^|;&]*?(?:-t\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s|;&"']+)|--target-directory=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s|;&"']+))/gm

// Extracts the destination directory from cp/mv -t <dir> or cp/mv --target-directory=<dir>.
// Both cp and mv support this GNU long-form flag. Group 1 = -t value; group 2 = --target-directory= value.
const CP_MV_TARGET_DIR_RE =
  /(?:^|[|;&\s])(?:cp|mv)\b[^|;&]*?(?:-t\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s|;&"']+)|--target-directory=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s|;&"']+))/gm

// Matches git [opts] checkout <tree-ish> -- <file> [file2 ...] patterns that overwrite working-tree files.
// The -- separator is required; everything after it is a path.
// Captures all tokens after the -- in group 1.
// Supports git global options like -C <dir> between git and checkout.
const GIT_CHECKOUT_FILES_RE = new RegExp(
  `(?:^|[|;&\\s])git\\s+${GIT_GLOBAL_OPTS}checkout\\b[^|;&]*?--\\s+((?:"[^"]*"|'[^']*'|[^\\s|;&"']+)(?:\\s+(?:"[^"]*"|'[^']*'|[^\\s|;&"']+))*)`,
  "gm"
)

// Matches git [opts] restore <file> [file2 ...] patterns that restore working-tree or staged files.
// Skips --source=<tree>, --staged, --worktree, and other flags; captures remaining path tokens.
// Supports git global options like -C <dir> between git and restore.
const GIT_RESTORE_RE = new RegExp(
  `(?:^|[|;&\\s])git\\s+${GIT_GLOBAL_OPTS}restore\\s+(?:(?:--source=\\S+|--staged|--worktree|-\\S+)\\s+)*((?:"[^"]*"|'[^']*'|[^\\s|;&"']+)(?:\\s+(?:"[^"]*"|'[^']*'|[^\\s|;&"']+))*)`,
  "gm"
)

// Matches patch <file> positional target: patch [-p<n>] [--dry-run] [flags] <file>
// Also handles patch -i <patchfile> <file> where -i consumes the patchfile argument.
// Captures the trailing path arguments (the files being patched) in group 1.
// Note: `patch < patchfile` rewrites paths embedded in the patch — not capturable here.
const PATCH_CMD_RE =
  /(?:^|[|;&\s])patch\s+(?:(?:-i\s+(?:"[^"]*"|'[^']*'|\S+)|--input=(?:"[^"]*"|'[^']*'|\S+)|-\S+)\s+)*((?:"[^"]*"|'[^']*'|[^\s|;&"'<>]+)(?:\s+(?:"[^"]*"|'[^']*'|[^\s|;&"'<>]+))*)/gm

// Tokenizes a shell argument string respecting single and double quoting.
// "my file.ts" and 'my file.ts' are returned as single tokens (quotes stripped).
// Unquoted whitespace is the delimiter. Flag tokens starting with '-' are excluded.
const SHELL_TOKEN_RE = /"([^"]*)"|'([^']*)'|([^\s]+)/g

function shellTokens(args: string): string[] {
  const tokens: string[] = []
  SHELL_TOKEN_RE.lastIndex = 0
  for (const m of args.matchAll(SHELL_TOKEN_RE)) {
    // Group 1 = double-quoted content, 2 = single-quoted content, 3 = unquoted token
    const token = m[1] ?? m[2] ?? m[3] ?? ""
    if (token && !token.startsWith("-")) tokens.push(token)
  }
  return tokens
}

// Regexes that extract file paths from group 1
const SINGLE_GROUP_PATH_REGEXES: RegExp[] = [
  SHELL_FILE_MOD_RE,
  REDIRECT_WRITE_RE,
  SED_INPLACE_RE,
  TEE_RE,
  TOUCH_TRUNCATE_INSTALL_RE,
  CHMOD_CHOWN_RE,
  INSTALL_CMD_RE,
  GIT_CHECKOUT_FILES_RE,
  GIT_RESTORE_RE,
  PATCH_CMD_RE,
]

// Regexes that extract file paths from group 1 or group 2 (whichever matched)
const DUAL_GROUP_PATH_REGEXES: RegExp[] = [INSTALL_TARGET_DIR_RE, CP_MV_TARGET_DIR_RE]

function collectRegexPaths(
  results: string[],
  command: string,
  regex: RegExp,
  useDualGroup: boolean
): void {
  regex.lastIndex = 0
  for (const m of command.matchAll(regex)) {
    const raw = useDualGroup ? (m[1] ?? m[2])?.trim() : m[1]?.trim()
    if (raw) for (const t of shellTokens(raw)) results.push(t)
  }
}

function extractPathsFromCommand(command: string): string[] {
  const results: string[] = []
  for (const regex of SINGLE_GROUP_PATH_REGEXES) {
    collectRegexPaths(results, command, regex, false)
  }
  for (const regex of DUAL_GROUP_PATH_REGEXES) {
    collectRegexPaths(results, command, regex, true)
  }
  return results
}

/**
 * Returns the set of file paths that were written, edited, deleted, or renamed
 * in the transcript. Covers:
 *   - Edit / Write / MultiEdit tool_use blocks (file_path / path input)
 *   - Bash tool_use blocks with file-modifying shell commands:
 *       trash, rm, mv, cp, ln, link, git mv/rm (deletions/renames/links)
 *       output redirections: > file, >> file (echo, cat, heredoc, etc.)
 *       sed -i in-place edits: sed -i 's/.../.../' file
 *       tee file targets: cmd | tee [-a] file [file2 ...]
 *       touch / truncate / mkdir / rmdir targets
 *       chmod / chown file targets: chmod [-R] <mode> <file>, chown [-R] <owner> <file>
 *       install command targets: install [-m mode] src... dest, install -t destdir src...,
 *         install --target-directory=destdir src...
 *       cp / mv -t / --target-directory destination directory
 *       git checkout <tree-ish> -- <file>: overwrites working-tree files
 *       git restore [--source=<tree>] <file>: restores working-tree/staged files
 *       patch [flags] <file>: applies a patch to a target file
 *
 * Used to detect docs-only sessions before invoking the LLM so the analysis
 * can be scoped correctly.
 */
export function extractEditedFilePaths(jsonlText: string): Set<string> {
  const paths = new Set<string>()

  for (const entry of parseTranscriptEntries(jsonlText)) {
    if (entry?.type !== "assistant") continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      const result = toolUseBlockSchema.safeParse(block)
      if (!result.success) continue
      collectEditedPath(result.data, paths)
    }
  }

  return paths
}

/**
 * Returns true when every file edited in the transcript is a documentation
 * or configuration file — meaning no source code was modified this session.
 * An empty set (no file edits at all) returns false (not "docs-only").
 */
export function isDocsOnlySession(editedPaths: Set<string>): boolean {
  if (editedPaths.size === 0) return false
  const DOC_EXT_RE = /\.(md|mdx|txt|rst|adoc|asciidoc|json|yaml|yml|toml|ini|env|cfg|conf)$/i
  const DOC_NAME_RE = /^(changelog|readme|contributing|license|authors|notice|todo)$/i
  for (const p of editedPaths) {
    const base = p.split("/").pop() ?? p
    const nameNoExt = base.replace(/\.[^.]+$/, "")
    if (!DOC_EXT_RE.test(base) && !DOC_NAME_RE.test(nameNoExt)) return false
  }
  return true
}

// ─── Combined single-pass extraction ─────────────────────────────────────────
// Performs one `parseTranscriptEntries` call and populates all three derived
// views: plain turns (for AI context), edited file paths (for docs-only check),
// and tool-call count (for the min-calls gate).
//
// Use this in stop hooks instead of calling extractPlainTurns + extractEditedFilePaths
// + countToolCalls separately to avoid three redundant full parses on large transcripts.

export interface TranscriptData {
  turns: PlainTurn[]
  editedPaths: Set<string>
  toolCallCount: number
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"])
const SHELL_TOOLS = new Set(["Bash", "Shell"])

function collectEditToolPath(
  input: Record<string, unknown> | undefined,
  editedPaths: Set<string>
): void {
  const pathVal = input?.file_path ?? input?.path
  if (typeof pathVal === "string" && pathVal) editedPaths.add(pathVal)
}

function collectShellToolPaths(
  input: Record<string, unknown> | undefined,
  editedPaths: Set<string>
): void {
  const cmd = input?.command
  if (typeof cmd === "string" && cmd) {
    for (const p of extractPathsFromCommand(cmd)) editedPaths.add(p)
  }
}

function collectEditedPath(
  b: { name?: string; input?: Record<string, unknown> },
  editedPaths: Set<string>
): void {
  if (!b.name) return
  if (EDIT_TOOLS.has(b.name)) collectEditToolPath(b.input, editedPaths)
  else if (SHELL_TOOLS.has(b.name)) collectShellToolPaths(b.input, editedPaths)
}

function countAndCollectToolBlocks(content: unknown[], editedPaths: Set<string>): number {
  let count = 0
  for (const block of content) {
    const parseResult = toolUseBlockSchema.safeParse(block)
    if (!parseResult.success) continue
    count++
    collectEditedPath(parseResult.data, editedPaths)
  }
  return count
}

function _processTranscriptEntry(
  entry: unknown,
  turns: PlainTurn[],
  editedPaths: Set<string>
): number {
  if (!entry) return 0
  const typed = entry as { type: string; message?: { content: unknown } }
  const { type: entryType, message } = typed
  if (entryType !== "user" && entryType !== "assistant") return 0

  const content = message?.content as string | ContentBlock[] | undefined
  let toolCount = 0

  if (entryType === "assistant" && Array.isArray(content)) {
    toolCount = countAndCollectToolBlocks(content, editedPaths)
  }

  if (!content || (entryType === "user" && isHookFeedback(content))) return toolCount

  const text = extractEntryText(content, entryType).trim()
  if (text) turns.push({ role: entryType as "user" | "assistant", text })
  return toolCount
}

export function extractTranscriptData(
  jsonlText: string,
  formatHint?: Session["format"]
): TranscriptData {
  const turns: PlainTurn[] = []
  const editedPaths = new Set<string>()
  let toolCallCount = 0

  for (const entry of parseTranscriptEntries(jsonlText, formatHint)) {
    toolCallCount += _processTranscriptEntry(entry, turns, editedPaths)
  }

  return { turns, editedPaths, toolCallCount }
}

// ─── Context formatting ──────────────────────────────────────────────────────
// Formats plain turns into a labeled conversation string for LLM prompts.

export function formatTurnsAsContext(turns: PlainTurn[]): string {
  return turns
    .map(({ role, text }) => `${role === "user" ? "User" : "Assistant"}: ${text}`)
    .join("\n\n")
}
