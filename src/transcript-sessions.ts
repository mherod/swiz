import { join, resolve } from "node:path"
import { getHomeDir } from "./home.ts"
import { projectKeyFromCwd } from "./project-key.ts"
import { createDefaultTaskStore } from "./task-roots.ts"
import { extractTranscriptData } from "./transcript-analysis.ts"
import type { Session, TranscriptResolution } from "./transcript-schemas.ts"
import {
  findAntigravitySessions,
  findCodexSessions,
  findCursorAgentTranscriptSessions,
  findCursorSessions,
  findGeminiSessions,
  findJunieSessions,
  findSessions,
  sortSessionsDeterministic,
} from "./transcript-sessions-discovery.ts"
import { getCachedFileText } from "./utils/file-cache.ts"

export { projectKeyFromCwd } from "./project-key.ts"

export { findSessions } from "./transcript-sessions-discovery.ts"

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
 * @param home
 * @param limit - Maximum number of sessions to return (returns most recent first). If undefined, returns all.
 * @returns Aggregated sessions from all providers, sorted by mtime descending
 */
export async function findAllProviderSessions(
  projectDir: string,
  home?: string,
  limit?: number
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
    junieSessions,
  ] = await Promise.all([
    findSessions(claudeProjectDir),
    findGeminiSessions(targetDir, effectiveHome),
    findCursorSessions(targetDir, effectiveHome),
    findCursorAgentTranscriptSessions(targetDir, effectiveHome),
    findAntigravitySessions(targetDir, effectiveHome),
    findCodexSessions(targetDir, effectiveHome),
    findJunieSessions(targetDir, effectiveHome),
  ])

  // Merge sessions from all providers, using CappedMap to bound memory when a limit is requested.
  const allSessions: Session[] = [
    ...claudeSessions.map((s) => ({ ...s, provider: "claude" as const, format: "jsonl" as const })),
    ...geminiSessions,
    ...cursorSessions,
    ...cursorAgentSessions,
    ...antigravitySessions,
    ...codexSessions,
    ...junieSessions,
  ]
  const sorted = sortSessionsDeterministic(allSessions)
  return limit !== undefined ? sorted.slice(0, limit) : sorted
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
    const raw = await getCachedFileText(transcriptPath)
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
      const raw = await getCachedFileText(session.path)
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
