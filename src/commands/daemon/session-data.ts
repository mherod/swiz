import { LRUCache } from "lru-cache"
import { readTasks } from "../../tasks/task-repository.ts"

import { getSessions } from "../../tasks/task-resolver.ts"
import {
  findAllProviderSessions,
  isHookFeedback,
  parseTranscriptEntries,
  projectKeyFromCwd,
  type Session,
  type TranscriptEntry,
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
    const extraction = SessionDataCache.extractMessages(entries)
    const { messages, toolCounts, pendingFallback } = extraction
    let { startedAt, lastMessageAt } = extraction

    const fallbackTimestamps = new Map<string, string>()
    let lastAssignedFallbackMs = prev?.lastAssignedFallbackMs ?? 0

    const fallbackResult = SessionDataCache.assignFallbackTimestamps({
      pendingFallback,
      messages,
      fallbackTimestamps,
      fileMtimeMs,
      initialSeed: lastAssignedFallbackMs,
      prev,
    })
    startedAt = fallbackResult.startedAt || startedAt
    lastMessageAt = Math.max(lastMessageAt, fallbackResult.lastMessageAt)
    lastAssignedFallbackMs = fallbackResult.seed

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

  private static buildMessage(
    entry: TranscriptEntry
  ): { message: SessionMessage; toolCalls: Array<{ name: string; detail: string }> } | null {
    if (entry.type !== "user" && entry.type !== "assistant") return null
    const content = entry.message?.content
    if (entry.type === "user" && isHookFeedback(content)) return null
    const extracted = extractMessageText(content)
    const toolCalls = extractToolCalls(content)
    if (!extracted && toolCalls.length === 0) return null
    return {
      message: {
        role: entry.type,
        timestamp: entry.timestamp ?? null,
        text: extracted,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      },
      toolCalls,
    }
  }

  private static trackFallbackSignature(
    message: SessionMessage,
    seenSignatures: Map<string, number>,
    pendingFallback: Array<{ messageIndex: number; key: string }>,
    messageIndex: number
  ) {
    const baseSig = `${message.role}\x00${message.text}\x00${JSON.stringify(message.toolCalls ?? [])}`
    const seen = (seenSignatures.get(baseSig) ?? 0) + 1
    seenSignatures.set(baseSig, seen)
    pendingFallback.push({ messageIndex, key: messageFallbackKey(message, seen) })
  }

  private static extractMessages(entries: ReturnType<typeof parseTranscriptEntries>) {
    const messages: SessionMessage[] = []
    const toolCounts = new Map<string, number>()
    const seenSignatures = new Map<string, number>()
    const pendingFallback: Array<{ messageIndex: number; key: string }> = []
    let startedAt = 0
    let lastMessageAt = 0

    for (const entry of entries) {
      const built = SessionDataCache.buildMessage(entry)
      if (!built) continue
      const { message, toolCalls } = built
      for (const tc of toolCalls) {
        toolCounts.set(tc.name, (toolCounts.get(tc.name) ?? 0) + 1)
      }
      messages.push(message)

      const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0
      if (ts > 0) {
        if (startedAt === 0 || ts < startedAt) startedAt = ts
        if (ts > lastMessageAt) lastMessageAt = ts
        continue
      }

      SessionDataCache.trackFallbackSignature(
        message,
        seenSignatures,
        pendingFallback,
        messages.length - 1
      )
    }
    return { messages, toolCounts, pendingFallback, startedAt, lastMessageAt }
  }

  private static assignFallbackTimestamps(opts: {
    pendingFallback: Array<{ messageIndex: number; key: string }>
    messages: SessionMessage[]
    fallbackTimestamps: Map<string, string>
    fileMtimeMs: number
    initialSeed: number
    prev?: CachedSessionData
  }) {
    const { pendingFallback, messages, fallbackTimestamps, fileMtimeMs, initialSeed, prev } = opts
    let seed = Math.max(initialSeed, fileMtimeMs - pendingFallback.length * 1000)
    let startedAt = 0
    let lastMessageAt = 0

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

    return { seed, startedAt, lastMessageAt }
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

  /** Invalidate only entries whose session path contains the project key for `cwd`. */
  invalidateProject(cwd: string): void {
    const projectKey = projectKeyFromCwd(cwd)
    for (const key of this.entries.keys()) {
      if (key.includes(projectKey)) this.entries.delete(key)
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

function ensurePinnedInList<T extends { session: Session }>(
  list: T[],
  pinnedSessionId: string | undefined,
  limit: number
): T[] {
  if (!pinnedSessionId) return list.slice(0, limit)
  let visible = list.slice(0, limit)
  const pinnedEntry = list.find(
    ({ session }) => session.id === pinnedSessionId || session.id.startsWith(pinnedSessionId)
  )
  if (pinnedEntry && !visible.some(({ session }) => session.id === pinnedEntry.session.id)) {
    visible = [pinnedEntry, ...visible].slice(0, limit)
  }
  return visible
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
  withMessages.sort((a, b) => {
    const aDisp = getRecentDispatches(a.session.id)
    const bDisp = getRecentDispatches(b.session.id)
    if (bDisp > 0 && aDisp === 0) return 1
    if (aDisp > 0 && bDisp === 0) return -1
    return effectiveLastMessage(b.session, b.scan) - effectiveLastMessage(a.session, a.scan)
  })
  const visible = ensurePinnedInList(withMessages, pinnedSessionId, limit)
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

async function resolveSession(cwd: string, sessionId: string) {
  const sessions = await findAllProviderSessions(cwd)
  const session = sessions.find(
    (candidate) => candidate.id === sessionId || candidate.id.startsWith(sessionId)
  )
  if (!session) return null
  const cached = await sessionDataCache.get(session)
  return cached ? { session, cached } : null
}

export async function getSessionData(
  cwd: string,
  sessionId: string,
  limit = 30,
  sessionToolCalls?: Map<string, CapturedToolCall[]>
): Promise<SessionData> {
  const resolved = await resolveSession(cwd, sessionId)
  if (!resolved) return { messages: [], toolStats: [] }
  const { session, cached } = resolved

  const messages = cached.messages.slice(-limit)
  const hasToolCalls = messages.some((message) => (message.toolCalls?.length ?? 0) > 0)
  const captured = (sessionToolCalls?.get(session.id) ?? []).map((entry) => ({
    name: entry.name,
    detail: entry.detail,
  }))
  if (captured.length === 0 || hasToolCalls || session.format !== "cursor-agent-jsonl") {
    return { messages, toolStats: cached.toolStats }
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

const TASK_READ_CONCURRENCY = 8

export async function getProjectTasks(
  cwd: string,
  limit = 100
): Promise<{ tasks: ProjectTaskPreview[]; summary: SessionTaskSummary }> {
  const sessions = await getSessions(cwd)

  // Read tasks in bounded-concurrency batches, preserving session order.
  const allTasks: ProjectTaskPreview[] = []
  for (let i = 0; i < sessions.length; i += TASK_READ_CONCURRENCY) {
    const batch = sessions.slice(i, i + TASK_READ_CONCURRENCY)
    const results = await Promise.all(
      batch.map((sid) => readTasks(sid).then((tasks) => ({ sid, tasks })))
    )
    for (const { sid, tasks } of results) {
      for (const task of tasks) {
        allTasks.push({
          sessionId: sid,
          id: task.id,
          subject: task.subject,
          status: task.status,
          statusChangedAt: task.statusChangedAt ?? null,
          completionTimestamp: task.completionTimestamp ?? null,
          completionEvidence: task.completionEvidence ?? null,
        })
      }
    }
  }

  return buildProjectTasksView(allTasks, limit)
}
