import { join } from "node:path"
import { LRUCache } from "lru-cache"
import { findTaskStoreForSession } from "../../task-roots.ts"
import { readTasks } from "../../tasks/task-repository.ts"
import { getSessions } from "../../tasks/task-resolver.ts"
import type { TaskStateCache } from "../../tasks/task-state-cache.ts"
import {
  parseTranscriptEntries,
  projectKeyFromCwd,
  type Session,
  type TranscriptEntry,
} from "../../transcript-utils.ts"
import { CappedMap } from "../../utils/capped-map.ts"
import type { JsonlAppendMetadata } from "../../utils/jsonl.ts"
import { ProviderSessionIndex } from "./cache/provider-session-index.ts"
import { HistoricalJsonlState, supportsHistoricalAppend } from "./session-jsonl.ts"
import {
  MAX_TRANSCRIPT_ENTRIES,
  messageRetainedChars,
  type PreparedSessionEntry,
  prepareSessionEntry,
  readTokenStats,
  type SessionTokenStats,
} from "./session-records.ts"

export type { SessionTokenStats } from "./session-records.ts"

import {
  MAX_SESSION_CACHE_BYTES,
  MAX_SESSION_PREVIEW_BYTES,
  readSessionPreview,
} from "./session-preview.ts"
import {
  buildProjectTasksView,
  buildSessionTasksView,
  type CapturedToolCall,
  mergeCapturedToolCalls,
  mergeToolStats,
  type ProjectTaskPreview,
  readPersistedSessionToolCalls,
  type SessionMessage,
  type SessionTaskPreview,
  type SessionTaskSummary,
  supplementMessagesWithCapturedToolCalls,
  toSessionTaskPreview,
} from "./utils.ts"

interface SessionScanResult {
  hasMessages: boolean
  startedAt: number
  lastMessageAt: number
}

/** Max messages cached per session. */
const MAX_SESSION_MESSAGES = 300

interface CachedSessionData {
  format?: Session["format"]
  metadata?: JsonlAppendMetadata
  jsonl?: HistoricalJsonlState
  mtimeMs: number
  size: number
  startedAt: number
  lastMessageAt: number
  messages: SessionMessage[]
  toolStats: Array<{ name: string; count: number }>
  fallbackTimestamps: CappedMap<string, string>
  lastAssignedFallbackMs: number
  /** Fingerprint of the last tool call detected in this session. */
  lastToolCallFingerprint?: string
  /** Fingerprint of the last assistant message text detected in this session. */
  lastMessageFingerprint?: string
  /**
   * Opaque revision of this entry's message content. Stable while the content is stable, so a
   * client can detect "nothing changed" in constant time instead of walking the whole array.
   */
  contentRevision?: string
  tokenStats?: SessionTokenStats
  projectIdentity?: string
  retainedBytes: number
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
  tokenStats?: SessionTokenStats
  /**
   * Opaque revision of `messages`. Equal revisions mean identical content, so a client can skip
   * comparing the array itself. Absent when the session could not be resolved; clients must fall
   * back to structural comparison rather than assuming "unchanged".
   */
  revision?: string
}

function messageFallbackKey(message: SessionMessage, occurrence: number): string {
  const toolSig = (message.toolCalls ?? []).map((tc) => `${tc.name}:${tc.detail}`).join("|")
  return `${message.role}\x00${message.text}\x00${toolSig}\x00${occurrence}`
}

function resolveSessionProjectIdentity(sessionPath: string, cwd?: string): string {
  if (cwd) return projectKeyFromCwd(cwd)
  const match = sessionPath.match(/.+projects\/([^/]+)\//)
  return match ? match[1]! : "unknown"
}

function isCacheFresh(
  cached: CachedSessionData | undefined,
  metadata: JsonlAppendMetadata,
  format: Session["format"]
): boolean {
  return (
    cached !== undefined &&
    cached.format === format &&
    cached.mtimeMs === metadata.mtimeMs &&
    cached.size === metadata.size &&
    cached.metadata?.dev === metadata.dev &&
    cached.metadata?.ino === metadata.ino
  )
}

/**
 * Opaque content revision for a parsed transcript.
 *
 * `mtimeMs` and `size` are the cache's own freshness key, so they already change on append,
 * deletion, reorder, and same-length edits (a rewrite bumps mtime even when the byte count is
 * unchanged). Message count and a hash of the last-message fingerprint are folded in to separate
 * two different edits that land in the same millisecond at the same size.
 *
 * The result carries no transcript text, session id, or file path — only digests and counters.
 */
export function computeContentRevision(input: {
  mtimeMs: number
  size: number
  messageCount: number
  lastMessageFingerprint?: string
  lastToolCallFingerprint?: string
}): string {
  const digest = Bun.hash(
    `${input.messageCount}\x00${input.lastMessageFingerprint ?? ""}\x00${input.lastToolCallFingerprint ?? ""}`
  ).toString(36)
  return `${input.mtimeMs.toString(36)}-${input.size.toString(36)}-${digest}`
}

/**
 * Narrow a whole-transcript revision to the window a caller actually receives.
 * Two clients polling the same session with different limits must not share a revision.
 */
export function scopeRevisionToWindow(
  contentRevision: string | undefined,
  limit: number,
  toolCallSignature?: string
): string | undefined {
  if (!contentRevision) return undefined
  const suffix = toolCallSignature ? `.${toolCallSignature}` : ""
  return `${contentRevision}.${limit.toString(36)}${suffix}`
}

export class SessionDataCache {
  private entries = new LRUCache<string, CachedSessionData>({
    max: 200,
    maxSize: MAX_SESSION_CACHE_BYTES,
    sizeCalculation: (entry) => entry.retainedBytes,
  })
  private readonly inflight = new Map<string, Promise<CachedSessionData | null>>()
  private activeLoads = 0
  private readonly waitingLoads: Array<() => void> = []
  private generation = 0

  constructor(private readonly fileForPath = (path: string) => Bun.file(path)) {}

  private buildFromEntries(
    entries: readonly PreparedSessionEntry[],
    fileMtimeMs: number,
    prev?: CachedSessionData
  ): CachedSessionData {
    const extraction = SessionDataCache.extractMessages(entries)
    const {
      messages,
      toolCounts,
      pendingFallback,
      lastToolCallFingerprint,
      lastMessageFingerprint,
    } = extraction
    let { startedAt, lastMessageAt } = extraction

    const fallbackTimestamps = new CappedMap<string, string>(500)
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
      lastToolCallFingerprint,
      lastMessageFingerprint,
      retainedBytes: 1,
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

  private static trackToolCalls(
    toolCalls: Array<{ name: string; detail: string }>,
    toolCounts: Map<string, number>,
    entry: Pick<TranscriptEntry, "timestamp">,
    entryIndex: number
  ): string | undefined {
    let fingerprint: string | undefined
    for (let index = 0; index < toolCalls.length; index++) {
      const toolCall = toolCalls[index]!
      toolCounts.set(toolCall.name, (toolCounts.get(toolCall.name) ?? 0) + 1)
      fingerprint = `${toolCall.name}:${toolCall.detail}:${entry.timestamp ?? ""}:${entryIndex}:${index}`
    }
    return fingerprint
  }

  private static trackTimestamp(
    entry: Pick<TranscriptEntry, "timestamp">,
    message: SessionMessage,
    messageIndex: number,
    current: { startedAt: number; lastMessageAt: number },
    fallback: {
      seenSignatures: Map<string, number>
      pendingFallback: Array<{ messageIndex: number; key: string }>
    }
  ): { startedAt: number; lastMessageAt: number } {
    const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : 0
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      SessionDataCache.trackFallbackSignature(
        message,
        fallback.seenSignatures,
        fallback.pendingFallback,
        messageIndex
      )
      return current
    }
    return {
      startedAt: current.startedAt === 0 ? timestamp : Math.min(current.startedAt, timestamp),
      lastMessageAt: Math.max(current.lastMessageAt, timestamp),
    }
  }

  private static trimExtractedMessages(
    messages: SessionMessage[],
    pendingFallback: Array<{ messageIndex: number; key: string }>
  ): void {
    const trimOffset = Math.max(0, messages.length - MAX_SESSION_MESSAGES)
    if (trimOffset === 0) return
    messages.splice(0, trimOffset)
    const firstRetained = pendingFallback.findIndex((entry) => entry.messageIndex >= trimOffset)
    pendingFallback.splice(0, firstRetained === -1 ? pendingFallback.length : firstRetained)
    for (const fallback of pendingFallback) fallback.messageIndex -= trimOffset
  }

  private static extractMessages(entries: readonly PreparedSessionEntry[]) {
    const messages: SessionMessage[] = []
    const toolCounts = new Map<string, number>()
    const seenSignatures = new Map<string, number>()
    const pendingFallback: Array<{ messageIndex: number; key: string }> = []
    let startedAt = 0
    let lastMessageAt = 0
    let lastToolCallFingerprint: string | undefined
    let lastMessageFingerprint: string | undefined

    // Cap entries to prevent OOM on huge transcripts. Keep only the last N entries.
    const startIdx =
      entries.length > MAX_TRANSCRIPT_ENTRIES ? entries.length - MAX_TRANSCRIPT_ENTRIES : 0

    for (let i = startIdx; i < entries.length; i++) {
      const entry = entries[i]!
      if (!entry.message) continue
      const message = { ...entry.message }
      const toolCalls = message.toolCalls ?? []
      lastToolCallFingerprint =
        SessionDataCache.trackToolCalls(toolCalls, toolCounts, entry, entry.position) ??
        lastToolCallFingerprint
      if (message.role === "assistant" && message.text) {
        lastMessageFingerprint = `assistant:${message.text.slice(-100)}:${entry.timestamp ?? ""}:${entry.position}`
      }
      messages.push(message)
      ;({ startedAt, lastMessageAt } = SessionDataCache.trackTimestamp(
        entry,
        message,
        messages.length - 1,
        { startedAt, lastMessageAt },
        { seenSignatures, pendingFallback }
      ))
    }

    SessionDataCache.trimExtractedMessages(messages, pendingFallback)

    return {
      messages,
      toolCounts,
      pendingFallback,
      startedAt,
      lastMessageAt,
      lastToolCallFingerprint,
      lastMessageFingerprint,
    }
  }

  private static assignFallbackTimestamps(opts: {
    pendingFallback: Array<{ messageIndex: number; key: string }>
    messages: SessionMessage[]
    fallbackTimestamps: CappedMap<string, string>
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

  async get(
    session: Pick<Session, "path" | "format">,
    cwd?: string
  ): Promise<CachedSessionData | null> {
    const key = `${session.path}\0${session.format ?? ""}`
    const pending = this.inflight.get(key)
    if (pending) return pending

    const loading = this.loadWithSlot(session, cwd).finally(() => {
      this.inflight.delete(key)
    })
    this.inflight.set(key, loading)
    return loading
  }

  /** Multiple dashboard projects share the same two read/parse slots. */
  private async loadWithSlot(
    session: Pick<Session, "path" | "format">,
    cwd?: string
  ): Promise<CachedSessionData | null> {
    const generation = this.generation
    if (this.activeLoads >= 2) await new Promise<void>((resolve) => this.waitingLoads.push(resolve))
    else this.activeLoads++
    try {
      if (generation !== this.generation) return null
      return await this.load(session, cwd, generation)
    } finally {
      const next = this.waitingLoads.shift()
      if (next) next()
      else this.activeLoads--
    }
  }

  private async load(
    session: Pick<Session, "path" | "format">,
    cwd: string | undefined,
    generation: number
  ): Promise<CachedSessionData | null> {
    try {
      const file = this.fileForPath(session.path)
      if (!(await file.exists())) {
        this.entries.delete(session.path)
        return null
      }
      const info = await file.stat()
      const mtimeMs = info.mtimeMs ?? 0
      const size = info.size
      const projectIdentity = resolveSessionProjectIdentity(session.path, cwd)

      const metadata = { size, mtimeMs, dev: info.dev, ino: info.ino }
      const cached = this.entries.get(session.path)
      const next = supportsHistoricalAppend(session.format)
        ? await this.loadJsonl(file, metadata, session.format, cached)
        : await this.loadFallback(file, metadata, session.format, cached)
      if (!next) {
        this.entries.delete(session.path)
        return null
      }
      next.projectIdentity = projectIdentity
      if (next === cached) return next
      next.format = session.format
      next.metadata = metadata
      next.size = size
      // Stamped here, where `size` is finally known. The entry is rebuilt only when the freshness
      // key changes, so this revision is stable exactly as long as the content is.
      next.contentRevision = computeContentRevision({
        mtimeMs,
        size,
        messageCount: next.messages.length,
        lastMessageFingerprint: next.lastMessageFingerprint,
        lastToolCallFingerprint: next.lastToolCallFingerprint,
      })
      next.retainedBytes =
        estimateRetainedBytes(next, Math.min(size, MAX_SESSION_PREVIEW_BYTES)) +
        (next.jsonl?.retainedBytes ?? 0)
      if (generation === this.generation) this.entries.set(session.path, next)
      return next
    } catch {
      this.entries.delete(session.path)
      return null
    }
  }

  private async loadJsonl(
    file: Bun.BunFile,
    metadata: JsonlAppendMetadata,
    format: HistoricalJsonlState["format"],
    cached?: CachedSessionData
  ): Promise<CachedSessionData> {
    const jsonl =
      cached?.format === format && cached.jsonl ? cached.jsonl : new HistoricalJsonlState(format)
    const kind = await jsonl.read(file, metadata)
    if (kind === "hit" && cached) return cached
    const view = jsonl.view(metadata.size)
    const next = this.buildFromEntries(
      view.entries,
      metadata.mtimeMs,
      kind === "cold" ? undefined : cached
    )
    next.tokenStats = view.tokenStats
    next.jsonl = jsonl
    return next
  }

  private async loadFallback(
    file: Bun.BunFile,
    metadata: JsonlAppendMetadata,
    format: Session["format"],
    cached?: CachedSessionData
  ): Promise<CachedSessionData | null> {
    if (cached && isCacheFresh(cached, metadata, format)) return cached
    const text = await readSessionPreview(file, metadata.size, format)
    if (text === null) return null
    const parsed = parseTranscriptEntries(text, format)
    const start = Math.max(0, parsed.length - MAX_TRANSCRIPT_ENTRIES)
    const prepared = parsed
      .slice(start)
      .map((entry, index) => prepareSessionEntry(entry, start + index))
    const next = this.buildFromEntries(
      prepared,
      metadata.mtimeMs,
      cached?.format === format ? cached : undefined
    )
    next.tokenStats = readTokenStats(text)
    return next
  }

  pruneOlderThan(cutoffMs: number): void {
    for (const [sessionPath, entry] of this.entries) {
      const activityMs = Math.max(entry.lastMessageAt, entry.mtimeMs)
      if (activityMs < cutoffMs) this.entries.delete(sessionPath)
    }
  }

  /** Invalidate only entries owned by the exact canonical project identity for `cwd`. */
  invalidateProject(cwd: string): void {
    const projectKey = projectKeyFromCwd(cwd)
    for (const [key, entry] of this.entries.entries()) {
      if (entry.projectIdentity === projectKey) {
        this.entries.delete(key)
      } else if (!entry.projectIdentity && key.includes(projectKey)) {
        this.entries.delete(key)
      }
    }
  }

  /** Keep only the last `limit` sessions per project. */
  pruneSessionsPerProject(limit: number): void {
    const projectSessions = new Map<string, string[]>()
    for (const [sessionPath, entry] of this.entries.entries()) {
      const projectKey = entry.projectIdentity ?? resolveSessionProjectIdentity(sessionPath)
      const list = projectSessions.get(projectKey) ?? []
      list.push(sessionPath)
      projectSessions.set(projectKey, list)
    }

    for (const [_, paths] of projectSessions) {
      if (paths.length <= limit) continue
      // Sort by last message time descending
      paths.sort((a, b) => {
        const dataA = this.entries.get(a)
        const dataB = this.entries.get(b)
        return (dataB?.lastMessageAt ?? 0) - (dataA?.lastMessageAt ?? 0)
      })
      for (let i = limit; i < paths.length; i++) {
        this.entries.delete(paths[i]!)
      }
    }
  }

  invalidateAll(): void {
    this.generation++
    this.entries.clear()
  }

  getMemoryStats(): { entries: number; estimatedBytes: number } {
    return { entries: this.entries.size, estimatedBytes: this.entries.calculatedSize }
  }
}

/** Include backing source strings and derived copies; deliberately overestimate shared strings. */
function estimateRetainedBytes(data: CachedSessionData, sourceChars: number): number {
  let chars = sourceChars + (data.lastToolCallFingerprint?.length ?? 0)
  chars += data.lastMessageFingerprint?.length ?? 0
  for (const message of data.messages) chars += messageRetainedChars(message)
  for (const [key, timestamp] of data.fallbackTimestamps) chars += key.length + timestamp.length
  for (const tool of data.toolStats) chars += tool.name.length
  return Math.max(1, chars * 2)
}

export const sessionDataCache = new SessionDataCache()

/** Shared provider discovery index; invalidated from the daemon's project watchers (#813). */
export const providerSessionIndex = new ProviderSessionIndex()

async function scanSession(
  session: Pick<Session, "path" | "format">,
  cwd?: string
): Promise<SessionScanResult> {
  const empty = { hasMessages: false, startedAt: 0, lastMessageAt: 0 }
  const cached = await sessionDataCache.get(session, cwd)
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
  const all = await providerSessionIndex.get(cwd)
  const candidates = all.slice(0, limit * 2)
  const pinned =
    typeof pinnedSessionId === "string" && pinnedSessionId.length > 0
      ? all.find((s) => s.id === pinnedSessionId || s.id.startsWith(pinnedSessionId))
      : null
  const scanTargets =
    pinned && !candidates.some((session) => session.id === pinned.id)
      ? [...candidates, pinned]
      : candidates
  const scans = await Promise.all(scanTargets.map((s) => scanSession(s, cwd)))
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
    // The project's session total, not the scan window's. `withMessages` is drawn from the first
    // `limit * 2` candidates, so counting it saturated at that cap: swiz (2252 sessions),
    // plugg-platform (170) and openai-sba-dashboard (24) all reported the same 16, which read as
    // the dashboard mixing projects up. Scanning every session just to count them is far too
    // expensive here, so the total comes from discovery and the scan stays a preview window.
    sessionCount: all.length,
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

export async function resolveSession(
  cwd: string,
  sessionId: string
): Promise<{ session: Session; cached: CachedSessionData } | null> {
  if (sessionId.trim().length === 0) return null
  // Shares one provider walk with listProjectSessions: the dashboard hits both on every poll.
  const sessions = await providerSessionIndex.get(cwd)
  const session = sessions.find(
    (candidate) => candidate.id === sessionId || candidate.id.startsWith(sessionId)
  )
  if (!session) return null
  const cached = await sessionDataCache.get(session, cwd)
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
  const persistedToolCalls = await readPersistedSessionToolCalls(cwd, session.id)
  const effectiveToolCalls = mergeCapturedToolCalls(
    persistedToolCalls,
    sessionToolCalls?.get(session.id) ?? []
  )
  const captured = effectiveToolCalls.map((entry) => ({
    name: entry.name,
    detail: entry.detail,
  }))
  if (captured.length === 0 || hasToolCalls || session.format !== "cursor-agent-jsonl") {
    return {
      messages,
      toolStats: cached.toolStats,
      tokenStats: cached.tokenStats,
      revision: scopeRevisionToWindow(cached.contentRevision, limit),
    }
  }

  const supplemented = supplementMessagesWithCapturedToolCalls(messages, effectiveToolCalls)
  return {
    messages: supplemented.slice(-limit),
    toolStats: mergeToolStats(cached.toolStats, captured),
    tokenStats: cached.tokenStats,
    // Captured tool calls arrive live and can change the payload without touching the file, so
    // the file-derived revision alone would go stale here.
    revision: scopeRevisionToWindow(
      cached.contentRevision,
      limit,
      Bun.hash(
        effectiveToolCalls.map((entry) => `${entry.name}\x00${entry.detail}`).join("\x01")
      ).toString(36)
    ),
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
  limit = 100,
  taskStateCache?: TaskStateCache,
  /**
   * Override the task store root for tests. When provided, overrides both the
   * `getSessions` lookup directory and the per-session `tasksDir` derivation so
   * tests can operate fully inside a temp directory without touching the real store.
   */
  tasksDir?: string,
  /** Override the projects directory for tests (passed through to getSessions). */
  projectsDir?: string
): Promise<{ tasks: ProjectTaskPreview[]; summary: SessionTaskSummary }> {
  const sessions = await getSessions(cwd, tasksDir, projectsDir)

  // Read tasks in bounded-concurrency batches, preserving session order.
  const allTasks: ProjectTaskPreview[] = []
  for (let i = 0; i < sessions.length; i += TASK_READ_CONCURRENCY) {
    const batch = sessions.slice(i, i + TASK_READ_CONCURRENCY)
    const results = await Promise.all(
      batch.map(async (sid) => {
        let tasks: import("../../tasks/task-recovery.ts").SessionTask[]
        if (taskStateCache) {
          // Use the watcher-backed cache so repeated polls for unchanged sessions
          // perform no per-task file reads (fixes #852: O(n*sessions) reads per poll).
          const effectiveTasksDir = tasksDir ?? findTaskStoreForSession(sid).tasksDir
          const sessionDir = join(effectiveTasksDir, sid)
          // Register a watcher so the cache stays invalidation-aware for this session.
          taskStateCache.watchSession(sid, sessionDir)
          tasks = await taskStateCache.getTasks(sid, sessionDir)
        } else {
          tasks = await readTasks(sid, tasksDir)
        }
        return { sid, tasks }
      })
    )
    for (const { sid, tasks } of results) {
      for (const task of tasks) {
        allTasks.push({ sessionId: sid, ...toSessionTaskPreview(task) })
      }
    }
  }

  return buildProjectTasksView(allTasks, limit)
}
