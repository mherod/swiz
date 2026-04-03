import { readdir, stat } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { getHomeDir } from "./home.ts"
import { projectKeyFromCwd } from "./project-key.ts"
import type { Session } from "./transcript-schemas.ts"
import {
  getCachedFileJson,
  getCachedFileText,
  getCachedLines,
  getCachedPrefix,
} from "./utils/file-cache.ts"
import { splitJsonlLines, tryParseJsonLine } from "./utils/jsonl.ts"

const SESSION_PROVIDER_PRECEDENCE = [
  "claude",
  "gemini",
  "cursor",
  "antigravity",
  "codex",
  "junie",
] as const

function providerRank(provider: Session["provider"] | undefined): number {
  if (!provider) return SESSION_PROVIDER_PRECEDENCE.length
  const idx = SESSION_PROVIDER_PRECEDENCE.indexOf(provider)
  return idx === -1 ? SESSION_PROVIDER_PRECEDENCE.length : idx
}

export function sortSessionsDeterministic(sessions: Session[]): Session[] {
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
    const raw = await getCachedFileText(path)
    const trimmed = raw.trim()
    return trimmed ? resolve(trimmed) : null
  } catch {
    return null
  }
}

async function readGeminiSessionId(sessionPath: string): Promise<string | null> {
  try {
    const parsed = (await getCachedFileJson(sessionPath)) as Record<string, any>
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

export async function findJunieSessions(targetDir: string, home?: string): Promise<Session[]> {
  home = home ?? getHomeDir()
  const junieSessionsDir = join(home, ".junie", "sessions")
  const target = resolve(targetDir)
  const sessions: Session[] = []

  let sessionDirs: import("node:fs").Dirent[]
  try {
    sessionDirs = await readdir(junieSessionsDir, { withFileTypes: true })
  } catch {
    return []
  }

  for (const dir of sessionDirs) {
    if (!dir.isDirectory()) continue
    const eventsPath = join(junieSessionsDir, dir.name, "events.jsonl")
    try {
      const s = await stat(eventsPath)
      // Read first 50 lines to check if it's for this project
      const lines = await getCachedLines(eventsPath, 50)
      for (const line of lines) {
        if (!line) continue
        const parsed = tryParseJsonLine(line) as Record<string, any> | undefined
        if (
          parsed?.cwd === target ||
          parsed?.payload?.cwd === target ||
          (parsed?.kind === "SessionA2uxEvent" &&
            parsed.event?.agentEvent?.blob?.includes(target)) ||
          (parsed?.event?.agentEvent?.kind === "AgentStateUpdatedEvent" &&
            parsed.event.agentEvent.blob?.includes(target))
        ) {
          sessions.push({
            id: dir.name,
            path: eventsPath,
            mtime: s.mtimeMs,
            provider: "junie",
            format: "junie-events",
          })
          break
        }
      }
    } catch {}
  }

  return sessions
}

export async function findGeminiSessions(targetDir: string, home?: string): Promise<Session[]> {
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

const CODEX_SESSION_HEADER_BYTES = 32_768

async function readFilePrefix(
  path: string,
  maxBytes = CODEX_SESSION_HEADER_BYTES
): Promise<string> {
  return getCachedPrefix(path, maxBytes)
}

function parseCodexIdFromFilename(name: string): string {
  const base = name.replace(/\.(jsonl|json)$/i, "")
  const uuidMatch = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  return uuidMatch?.[0] ?? base
}

const CODEX_META_TYPES = new Set(["session_meta", "turn_context"])

function extractCodexMetaPayload(line: string): Record<string, any> | null {
  const parsed = tryParseJsonLine(line)
  if (!parsed || typeof parsed !== "object") return null
  const record = parsed as Record<string, any>
  if (!CODEX_META_TYPES.has(record.type as string)) return null
  const payload = record.payload
  if (!payload || typeof payload !== "object") return null
  return payload as Record<string, any>
}

function extractStringMeta(payload: Record<string, any>, key: string): string | null {
  const val = payload[key]
  return typeof val === "string" && val.trim() ? (val as string) : null
}

async function readCodexSessionMeta(
  sessionPath: string
): Promise<{ id: string | null; cwd: string | null }> {
  const prefix = await readFilePrefix(sessionPath)
  if (!prefix) return { id: null, cwd: null }

  let id: string | null = null
  let cwd: string | null = null

  for (const line of splitJsonlLines(prefix)) {
    const payload = extractCodexMetaPayload(line)
    if (!payload) continue

    id ??= extractStringMeta(payload, "id")
    cwd ??= extractStringMeta(payload, "cwd")
    if (id && cwd) break
  }

  return { id, cwd }
}

async function processCodexFileEntry(
  entryPath: string,
  entryName: string,
  targetPath: string,
  sessions: Session[]
): Promise<void> {
  const { id: parsedId, cwd } = await readCodexSessionMeta(entryPath)
  if (!cwd || resolve(cwd) !== targetPath) return
  try {
    const s = await stat(entryPath)
    sessions.push({
      id: parsedId ?? parseCodexIdFromFilename(entryName),
      path: entryPath,
      mtime: s.mtimeMs,
      provider: "codex",
      format: "codex-jsonl",
    })
  } catch {}
}

export async function findCodexSessions(targetDir: string, home?: string): Promise<Session[]> {
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
      await processCodexFileEntry(entryPath, entry.name, targetPath, sessions)
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
    const text = await getCachedFileText(sessionPath)
    return text.includes(targetPath) || text.includes(fileUrlNeedle)
  } catch {
    return false
  }
}

async function processCursorSessionEntry(
  sessionEntry: import("node:fs").Dirent,
  workspaceDir: string,
  targetDir: string,
  sessions: Session[]
): Promise<void> {
  if (!sessionEntry.isDirectory()) return
  const sessionDir = join(workspaceDir, sessionEntry.name)
  const sessionPath = join(sessionDir, "store.db")
  try {
    const s = await stat(sessionPath)
    if (!s.isFile()) return
  } catch {
    return
  }
  if (!(await cursorSessionMatchesTarget(sessionPath, targetDir))) return
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

export async function findCursorSessions(targetDir: string, home?: string): Promise<Session[]> {
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
      await processCursorSessionEntry(sessionEntry, workspaceDir, targetDir, sessions)
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

export async function findCursorAgentTranscriptSessions(
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
      const content = await getCachedFileText(join(brainSessionDir, name))
      const sample = content.slice(0, 200_000)
      if (sample.includes(fileUrlNeedle) || sample.includes(targetPath)) {
        return true
      }
    } catch {}
  }

  return false
}

export async function findAntigravitySessions(
  targetDir: string,
  home?: string
): Promise<Session[]> {
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
