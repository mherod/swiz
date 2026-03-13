import { LRUCache } from "lru-cache"
import { readTasks } from "../../tasks/task-repository.ts"

import { getSessions } from "../../tasks/task-resolver.ts"
import {
  findAllProviderSessions,
  isHookFeedback,
  parseTranscriptEntries,
  type Session,
} from "../../transcript-utils.ts"
import {
  buildProjectTasksView,
  buildSessionTasksView,
  type CapturedToolCall,
  extractMessageText,
  extractToolCalls,
  mergeToolStats,
  type ProjectTaskPreview,
  type SessionMessage,
  type SessionTaskPreview,
  type SessionTaskSummary,
  supplementMessagesWithCapturedToolCalls,
} from "./utils.ts"

interface SessionScanResult {
  hasMessages: boolean
  startedAt: number
  lastMessageAt: number
}

interface CachedSessionData {
  mtimeMs: number
  size: number
  startedAt: number
  lastMessageAt: number
  messages: SessionMessage[]
  toolStats: Array<{ name: string; count: number }>
  fallbackTimestamps: Map<string, string>
  lastAssignedFallbackMs: number
}

export interface SessionPreview {
  id: string
  provider?: Session["provider"]
  format?: Session["format"]
  mtime: number
  startedAt?: number
  lastMessageAt?: number
  dispatches?: number
}

interface SessionData {
  messages: SessionMessage[]
  toolStats: Array<{ name: string; count: number }>
}

function messageFallbackKey(message: SessionMessage, occurrence: number): string {
  const toolSig = (message.toolCalls ?? []).map((tc) => `${tc.name}:${tc.detail}`).join("|")
  return `${message.role}\x00${message.text}\x00${toolSig}\x00${occurrence}`
}

class SessionDataCache {
  private entries = new LRUCache<string, CachedSessionData>({ max: 200 })

  private buildFromEntries(
    entries: ReturnType<typeof parseTranscriptEntries>,
    fileMtimeMs: number,
    prev?: CachedSessionData
  ): CachedSessionData {
    const messages: SessionMessage[] = []
    const toolCounts = new Map<string, number>()
    const fallbackTimestamps = new Map<string, string>()
    const seenSignatures = new Map<string, number>()
    const pendingFallback: Array<{ messageIndex: number; key: string }> = []

    let startedAt = 0
    let lastMessageAt = 0
    let lastAssignedFallbackMs = prev?.lastAssignedFallbackMs ?? 0

    for (const entry of entries) {
      if (entry.type !== "user" && entry.type !== "assistant") continue
      const content = entry.message?.content
      if (entry.type === "user" && isHookFeedback(content)) continue

      const extracted = extractMessageText(content)
      const toolCalls = extractToolCalls(content)
      for (const tc of toolCalls) {
        toolCounts.set(tc.name, (toolCounts.get(tc.name) ?? 0) + 1)
      }
      if (!extracted && toolCalls.length === 0) continue

      const message: SessionMessage = {
        role: entry.type,
        timestamp: entry.timestamp ?? null,
        text: extracted,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      }
      messages.push(message)

      const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0
      if (ts > 0) {
        if (startedAt === 0 || ts < startedAt) startedAt = ts
        if (ts > lastMessageAt) lastMessageAt = ts
        continue
      }

      const baseSig = `${message.role}\x00${message.text}\x00${JSON.stringify(message.toolCalls ?? [])}`
      const seen = (seenSignatures.get(baseSig) ?? 0) + 1
      seenSignatures.set(baseSig, seen)
      pendingFallback.push({
        messageIndex: messages.length - 1,
        key: messageFallbackKey(message, seen),
      })
    }

    // Assign stable synthetic timestamps for transcripts that don't include per-message times.
    // Existing keys preserve prior assigned times; new keys get monotonic timestamps.
    let seed = Math.max(lastAssignedFallbackMs, fileMtimeMs - pendingFallback.length * 1000)
    for (let i = 0; i < pendingFallback.length; i++) {
      const target = pendingFallback[i]!
      const priorIso = prev?.fallbackTimestamps.get(target.key) ?? null
      let assignedMs = priorIso ? new Date(priorIso).getTime() : 0
      if (!assignedMs || Number.isNaN(assignedMs)) {
        const minForOrder = fileMtimeMs - (pendingFallback.length - i) * 1000
        assignedMs = Math.max(seed + 1000, minForOrder)
      }
      seed = Math.max(seed, assignedMs)
      const iso = new Date(assignedMs).toISOString()
      fallbackTimestamps.set(target.key, iso)
      messages[target.messageIndex]!.timestamp = iso
      if (startedAt === 0 || assignedMs < startedAt) startedAt = assignedMs
      if (assignedMs > lastMessageAt) lastMessageAt = assignedMs
    }
    lastAssignedFallbackMs = seed

    const toolStats = [...toolCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)

    return {
      mtimeMs: fileMtimeMs,
      size: 0,
      startedAt,
      lastMessageAt,
      messages,
      toolStats,
      fallbackTimestamps,
      lastAssignedFallbackMs,
    }
  }

  async get(session: Pick<Session, "path" | "format">): Promise<CachedSessionData | null> {
    try {
      const file = Bun.file(session.path)
      if (!(await file.exists())) return null
      const info = await file.stat()
      const mtimeMs = info.mtimeMs ?? 0
      const size = info.size

      const cached = this.entries.get(session.path)
      if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
        return cached
      }

      const text = await file.text()
      const parsed = parseTranscriptEntries(text, session.format)
      const next = this.buildFromEntries(parsed, mtimeMs, cached)
      next.mtimeMs = mtimeMs
      next.size = size
      this.entries.set(session.path, next)
      return next
    } catch {
      return null
    }
  }

  pruneOlderThan(cutoffMs: number): void {
    for (const [sessionPath, entry] of this.entries) {
      const activityMs = Math.max(entry.lastMessageAt, entry.mtimeMs)
      if (activityMs < cutoffMs) this.entries.delete(sessionPath)
    }
  }

  invalidateAll(): void {
    this.entries.clear()
  }
}

export const sessionDataCache = new SessionDataCache()

async function scanSession(session: Pick<Session, "path" | "format">): Promise<SessionScanResult> {
  const empty = { hasMessages: false, startedAt: 0, lastMessageAt: 0 }
  const cached = await sessionDataCache.get(session)
  if (!cached) return empty
  if (cached.messages.length === 0) return empty
  return {
    hasMessages: true,
    startedAt: cached.startedAt,
    lastMessageAt: cached.lastMessageAt,
  }
}

export async function listProjectSessions(
  cwd: string,
  limit = 20,
  liveActivity?: Map<string, { lastSeen: number; dispatches: number }>,
  pinnedSessionId?: string
): Promise<{ sessionCount: number; sessions: SessionPreview[] }> {
  const all = await findAllProviderSessions(cwd)
  const candidates = all.slice(0, limit * 2)
  const pinned =
    typeof pinnedSessionId === "string" && pinnedSessionId.length > 0
      ? all.find((s) => s.id === pinnedSessionId || s.id.startsWith(pinnedSessionId))
      : null
  const scanTargets =
    pinned && !candidates.some((session) => session.id === pinned.id)
      ? [...candidates, pinned]
      : candidates
  const scans = await Promise.all(scanTargets.map((s) => scanSession(s)))
  const withMessages: Array<{ session: Session; scan: SessionScanResult }> = []
  for (let i = 0; i < scanTargets.length; i++) {
    if (scans[i]!.hasMessages) withMessages.push({ session: scanTargets[i]!, scan: scans[i]! })
  }
  const ACTIVE_DISPATCH_WINDOW_MS = 6 * 60 * 1000
  const getActivity = (id: string) => liveActivity?.get(id)
  const getRecentDispatches = (id: string): number => {
    const activity = getActivity(id)
    if (!activity) return 0
    return Date.now() - activity.lastSeen <= ACTIVE_DISPATCH_WINDOW_MS ? activity.dispatches : 0
  }
  const effectiveLastMessage = (s: Session, scan: SessionScanResult): number => {
    const live = getActivity(s.id)?.lastSeen ?? 0
    return Math.max(scan.lastMessageAt, live)
  }
  // Sort: sessions with dispatch activity first, then by last message time
  withMessages.sort((a, b) => {
    const aDisp = getRecentDispatches(a.session.id)
    const bDisp = getRecentDispatches(b.session.id)
    if (bDisp > 0 && aDisp === 0) return 1
    if (aDisp > 0 && bDisp === 0) return -1
    return effectiveLastMessage(b.session, b.scan) - effectiveLastMessage(a.session, a.scan)
  })
  let visible = withMessages.slice(0, limit)
  if (pinnedSessionId) {
    const pinnedEntry = withMessages.find(
      ({ session }) => session.id === pinnedSessionId || session.id.startsWith(pinnedSessionId)
    )
    if (pinnedEntry && !visible.some(({ session }) => session.id === pinnedEntry.session.id)) {
      visible = [pinnedEntry, ...visible].slice(0, limit)
    }
  }
  return {
    sessionCount: withMessages.length,
    sessions: visible.map(({ session, scan }) => ({
      id: session.id,
      provider: session.provider,
      format: session.format,
      mtime: session.mtime,
      startedAt: scan.startedAt || undefined,
      lastMessageAt: effectiveLastMessage(session, scan) || undefined,
      dispatches: getRecentDispatches(session.id) || undefined,
    })),
  }
}

export async function getSessionData(
  cwd: string,
  sessionId: string,
  limit = 30,
  sessionToolCalls?: Map<string, CapturedToolCall[]>
): Promise<SessionData> {
  const sessions = await findAllProviderSessions(cwd)
  const session = sessions.find(
    (candidate) => candidate.id === sessionId || candidate.id.startsWith(sessionId)
  )
  if (!session) return { messages: [], toolStats: [] }
  const cached = await sessionDataCache.get(session)
  if (!cached) return { messages: [], toolStats: [] }

  const messages = cached.messages.slice(-limit)
  const hasToolCalls = messages.some((message) => (message.toolCalls?.length ?? 0) > 0)
  const captured = (sessionToolCalls?.get(session.id) ?? []).map((entry) => ({
    name: entry.name,
    detail: entry.detail,
  }))
  if (captured.length === 0 || hasToolCalls || session.format !== "cursor-agent-jsonl") {
    return {
      messages,
      toolStats: cached.toolStats,
    }
  }

  const supplemented = supplementMessagesWithCapturedToolCalls(
    messages,
    sessionToolCalls?.get(session.id) ?? []
  )
  return {
    messages: supplemented.slice(-limit),
    toolStats: mergeToolStats(cached.toolStats, captured),
  }
}

export async function getSessionTasks(
  sessionId: string,
  limit = 20
): Promise<{ tasks: SessionTaskPreview[]; summary: SessionTaskSummary }> {
  const tasks = await readTasks(sessionId)
  return buildSessionTasksView(tasks, limit)
}

export async function getProjectTasks(
  cwd: string,
  limit = 100
): Promise<{ tasks: ProjectTaskPreview[]; summary: SessionTaskSummary }> {
  const sessions = await getSessions(cwd)
  const allTasks: ProjectTaskPreview[] = []
  for (const sessionId of sessions) {
    const sessionTasks = await readTasks(sessionId)
    for (const task of sessionTasks) {
      allTasks.push({
        sessionId,
        id: task.id,
        subject: task.subject,
        status: task.status,
        statusChangedAt: task.statusChangedAt ?? null,
        completionTimestamp: task.completionTimestamp ?? null,
        completionEvidence: task.completionEvidence ?? null,
      })
    }
  }

  return buildProjectTasksView(allTasks, limit)
}
