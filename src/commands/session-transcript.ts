import type { Session } from "../transcript-schemas.ts"
import {
  findAllProviderSessions,
  getUnsupportedTranscriptFormatMessage,
  isUnsupportedTranscriptFormat,
} from "../transcript-sessions.ts"

/** Select a requested session, or the newest session whose format we can read. */
export async function resolveSession(
  targetDir: string,
  sessionQuery: string | null
): Promise<Session> {
  const sessions = await findAllProviderSessions(targetDir)
  if (sessions.length === 0) throw new Error(`No transcripts found for: ${targetDir}`)
  const session = sessionQuery
    ? sessions.find((candidate) => candidate.id.startsWith(sessionQuery))
    : (sessions.find((candidate) => !isUnsupportedTranscriptFormat(candidate.format)) ??
      sessions[0])
  if (!session) throw new Error(`No session matching: ${sessionQuery}`)
  if (isUnsupportedTranscriptFormat(session.format)) {
    throw new Error(getUnsupportedTranscriptFormatMessage(session))
  }
  return session
}

export async function readTranscriptText(session: Session): Promise<string> {
  try {
    return await Bun.file(session.path).text()
  } catch {
    throw new Error(`Could not read transcript: ${session.path}`)
  }
}
