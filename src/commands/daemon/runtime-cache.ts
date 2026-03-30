import { type FSWatcher, watch } from "node:fs"
import { LRUCache } from "lru-cache"
import { detectProjectStack } from "../../detect-frameworks.ts"
import { resolvePrMergeActive } from "../../dispatch/filters.ts"
import { type GitBranchStatus, getGitBranchStatus, ghJson } from "../../git-helpers.ts"
import {
  evalCondition,
  type HookGroup,
  hookIdentifier,
  isInlineHookDef,
  manifest,
} from "../../manifest.ts"
import {
  getEffectiveSwizSettings,
  type ProjectSwizSettings,
  readProjectSettings,
  readProjectState,
  readSwizSettings,
  resolveProjectHooks,
} from "../../settings.ts"
import { getWorkflowIntent } from "../../state-machine.ts"
import { parseTranscriptSummary, type TranscriptSummary } from "../../transcript-summary.ts"
import { projectKeyFromCwd } from "../../transcript-utils.ts"

export interface EventMetrics {
  count: number
  totalMs: number
}

export interface DaemonMetrics {
  startedAt: number
  dispatches: Map<string, EventMetrics>
}

export function createMetrics(): DaemonMetrics {
  return { startedAt: Date.now(), dispatches: new Map() }
}

export function recordDispatch(metrics: DaemonMetrics, event: string, durationMs: number): void {
  const existing = metrics.dispatches.get(event)
  if (existing) {
    existing.count += 1
    existing.totalMs += durationMs
  } else {
    metrics.dispatches.set(event, { count: 1, totalMs: durationMs })
  }
}

export function serializeMetrics(metrics: DaemonMetrics): {
  uptimeMs: number
  uptimeHuman: string
  totalDispatches: number
  byEvent: Record<string, { count: number; avgMs: number }>
} {
  const uptimeMs = Date.now() - metrics.startedAt
  const byEvent: Record<string, { count: number; avgMs: number }> = {}
  let totalDispatches = 0
  for (const [event, m] of metrics.dispatches) {
    byEvent[event] = { count: m.count, avgMs: Math.round(m.totalMs / m.count) }
    totalDispatches += m.count
  }
  return {
    uptimeMs,
    uptimeHuman: formatUptime(uptimeMs),
    totalDispatches,
    byEvent,
  }
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m ${sec}s`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

export interface WatchEntry {
  path: string
  label: string
  callbacks: Set<() => void>
  watcher: FSWatcher | null
  lastInvalidation: number | null
  invalidationCount: number
}

/**
 * Registry of file-system watchers that trigger cache invalidation callbacks.
 *
 * Used by the daemon to keep caches consistent when hook source files,
 * manifest, settings, or git state change on disk — without requiring a
 * daemon restart. The `hooks/` directory watcher performs a full cache flush
 * on any modification because `HookEligibilityCache` is keyed by `cwd` (not
 * by individual hook file), making per-hook granularity impractical. Since
 * hook edits are infrequent the full-flush approach is cheap and correct.
 */
export class FileWatcherRegistry {
  private entries = new Map<string, WatchEntry>()

  register(path: string, label: string, callback: () => void): void {
    let entry = this.entries.get(path)
    if (!entry) {
      entry = {
        path,
        label,
        callbacks: new Set(),
        watcher: null,
        lastInvalidation: null,
        invalidationCount: 0,
      }
      this.entries.set(path, entry)
    }
    entry.callbacks.add(callback)
  }

  start(): void {
    for (const entry of this.entries.values()) {
      if (entry.watcher) continue
      try {
        entry.watcher = watch(entry.path, { recursive: entry.path.endsWith("/") }, () => {
          entry.lastInvalidation = Date.now()
          entry.invalidationCount += 1
          for (const cb of entry.callbacks) {
            try {
              cb()
            } catch {
              // ignore callback errors
            }
          }
        })
      } catch {
        // path may not exist yet — that's fine
      }
    }
  }

  /** Close and remove all watchers whose label ends with the given suffix. */
  unregisterByLabelSuffix(suffix: string): number {
    let removed = 0
    for (const [path, entry] of this.entries) {
      if (entry.label.endsWith(suffix)) {
        entry.watcher?.close()
        entry.watcher = null
        this.entries.delete(path)
        removed++
      }
    }
    return removed
  }

  close(): void {
    for (const entry of this.entries.values()) {
      entry.watcher?.close()
      entry.watcher = null
    }
  }

  status(): Array<{
    path: string
    label: string
    watching: boolean
    lastInvalidation: number | null
    invalidationCount: number
  }> {
    return [...this.entries.values()].map((e) => ({
      path: e.path,
      label: e.label,
      watching: e.watcher !== null,
      lastInvalidation: e.lastInvalidation,
      invalidationCount: e.invalidationCount,
    }))
  }
}

export const GH_QUERY_TTL_MS = 20_000

interface GhCacheEntry {
  value: unknown
  expiresAt: number
}

type GhFetcher = (args: string[], cwd: string) => Promise<unknown>

export class GhQueryCache {
  private entries = new LRUCache<string, GhCacheEntry>({ max: 500 })
  private fetcher: GhFetcher
  private _hits = 0
  private _misses = 0

  constructor(fetcher?: GhFetcher) {
    this.fetcher = fetcher ?? ((args, cwd) => ghJson(args, cwd))
  }

  private key(args: string[], cwd: string): string {
    return `${cwd}\x00${args.join("\x00")}`
  }

  async get(
    args: string[],
    cwd: string,
    ttlMs: number = GH_QUERY_TTL_MS
  ): Promise<{ hit: boolean; value: unknown }> {
    const k = this.key(args, cwd)
    const entry = this.entries.get(k)
    if (entry && entry.expiresAt > Date.now()) {
      this._hits++
      return { hit: true, value: entry.value }
    }
    this._misses++
    const value = await this.fetcher(args, cwd)
    this.entries.set(k, { value, expiresAt: Date.now() + Math.max(0, ttlMs) })
    return { hit: false, value }
  }

  invalidateProject(cwd: string): void {
    for (const k of this.entries.keys()) {
      if (k.startsWith(cwd)) this.entries.delete(k)
    }
  }

  invalidateAll(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }

  get hits(): number {
    return this._hits
  }

  get misses(): number {
    return this._misses
  }

  get evictions(): number {
    return this.entries.size > 0 ? 0 : 0
  }
}

export interface EligibilitySnapshot {
  disabledHooks: string[]
  detectedStacks: string[]
  prMergeActive: boolean
  workflowIntent: string | null
  conditionResults: Record<string, boolean>
  computedAt: number
}

export class HookEligibilityCache {
  private entries = new Map<string, EligibilitySnapshot>()
  private inFlight = new Map<string, Promise<EligibilitySnapshot>>()

  async compute(cwd: string): Promise<EligibilitySnapshot> {
    const cached = this.entries.get(cwd)
    if (cached) return cached

    const inflight = this.inFlight.get(cwd)
    if (inflight) return inflight

    const computation = computeEligibility(cwd).then((snapshot) => {
      this.entries.set(cwd, snapshot)
      this.inFlight.delete(cwd)
      return snapshot
    })
    this.inFlight.set(cwd, computation)
    return computation
  }

  invalidateProject(cwd: string): void {
    this.entries.delete(cwd)
  }

  invalidateAll(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}

async function resolveWorkflowIntent(cwd: string): Promise<string | null> {
  try {
    const state = await readProjectState(cwd)
    return state ? getWorkflowIntent(state) : null
  } catch {
    return null
  }
}

async function evalHookConditions(
  groups: HookGroup[],
  results: Record<string, boolean>
): Promise<void> {
  const pending: Array<{ file: string; condition: string }> = []
  for (const group of groups)
    for (const hook of group.hooks) {
      if (isInlineHookDef(hook)) continue
      if (hook.condition && !(hookIdentifier(hook) in results))
        pending.push({ file: hook.file, condition: hook.condition })
    }

  if (pending.length === 0) return
  const evaluated = await Promise.all(pending.map(({ condition }) => evalCondition(condition)))
  for (let i = 0; i < pending.length; i++) results[pending[i]!.file] = evaluated[i]!
}

async function computeEligibility(cwd: string): Promise<EligibilitySnapshot> {
  const [settings, projectSettings, detectedStacks, workflowIntent] = await Promise.all([
    readSwizSettings(),
    cwd ? readProjectSettings(cwd) : Promise.resolve(null),
    cwd ? detectProjectStack(cwd) : Promise.resolve([]),
    resolveWorkflowIntent(cwd),
  ])
  const effective = getEffectiveSwizSettings(settings, null)

  const disabledSet = new Set([
    ...(settings.disabledHooks ?? []),
    ...(projectSettings?.disabledHooks ?? []),
  ])
  const prMergeActive = resolvePrMergeActive(effective.collaborationMode, effective.prMergeMode)

  const conditionResults: Record<string, boolean> = {}
  await evalHookConditions(manifest, conditionResults)
  if (projectSettings?.hooks?.length) {
    const { resolved } = resolveProjectHooks(projectSettings.hooks, cwd)
    await evalHookConditions(resolved, conditionResults)
  }

  return {
    disabledHooks: [...disabledSet],
    detectedStacks,
    prMergeActive,
    workflowIntent,
    conditionResults,
    computedAt: Date.now(),
  }
}

export interface TranscriptIndex {
  summary: TranscriptSummary
  blockedToolUseIds: string[]
  mtimeMs: number
  computedAt: number
}

function extractToolResultText(block: { content?: string | unknown[] }): string {
  const blockContent = block.content
  if (typeof blockContent === "string") return blockContent
  if (!Array.isArray(blockContent)) return ""
  return (blockContent as Array<{ text?: string }>)
    .map((c) => (typeof c === "string" ? c : (c?.text ?? "")))
    .join("")
}

type ToolResultBlock = { type?: string; content?: string | unknown[]; tool_use_id?: string }

function isBlockedToolResult(block: ToolResultBlock): boolean {
  return block?.type === "tool_result" && extractToolResultText(block).includes("ACTION REQUIRED:")
}

function collectBlockedIdsFromEntry(line: string, blockedIds: string[]): void {
  const entry = JSON.parse(line) as {
    type?: string
    message?: { content?: string | unknown[] }
  }
  if (entry?.type !== "user") return
  const content = entry?.message?.content
  if (!Array.isArray(content)) return
  for (const block of content as ToolResultBlock[]) {
    if (isBlockedToolResult(block)) {
      blockedIds.push(String(block.tool_use_id ?? ""))
    }
  }
}

function extractBlockedToolUseIds(sessionLines: string[]): string[] {
  const blockedIds: string[] = []
  for (const line of sessionLines) {
    if (!line.trim()) continue
    try {
      collectBlockedIdsFromEntry(line, blockedIds)
    } catch {}
  }
  return blockedIds
}

export class TranscriptIndexCache {
  private entries = new LRUCache<string, TranscriptIndex>({ max: 200 })
  private _hits = 0
  private _misses = 0

  async get(transcriptPath: string): Promise<TranscriptIndex | null> {
    try {
      const file = Bun.file(transcriptPath)
      const stat = await file.stat()
      const mtimeMs = stat.mtimeMs ?? 0
      const cached = this.entries.get(transcriptPath)
      if (cached && cached.mtimeMs === mtimeMs) {
        cached.computedAt = Date.now()
        this._hits++
        return cached
      }
      this._misses++
      const text = await file.text()
      const summary = parseTranscriptSummary(text)
      const blockedIds = extractBlockedToolUseIds(summary.sessionLines)
      const index: TranscriptIndex = {
        summary,
        blockedToolUseIds: blockedIds,
        mtimeMs,
        computedAt: Date.now(),
      }
      this.entries.set(transcriptPath, index)
      return index
    } catch {
      return null
    }
  }

  /** Invalidate only entries whose transcript path contains the project key for `cwd`. */
  invalidateProject(cwd: string): void {
    const projectKey = projectKeyFromCwd(cwd)
    for (const key of this.entries.keys()) {
      if (key.includes(projectKey)) this.entries.delete(key)
    }
  }

  invalidateAll(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }

  get hits(): number {
    return this._hits
  }

  get misses(): number {
    return this._misses
  }

  pruneOlderThan(cutoffMs: number): void {
    for (const [path, entry] of this.entries) {
      if (entry.computedAt < cutoffMs) this.entries.delete(path)
    }
  }
}

export class CooldownRegistry {
  private entries = new Map<string, number>()

  private key(hookFile: string, cwd: string): string {
    return `${hookFile}\x00${cwd}`
  }

  isWithinCooldown(hookFile: string, cooldownSeconds: number, cwd: string): boolean {
    const lastRun = this.entries.get(this.key(hookFile, cwd))
    if (lastRun === undefined) return false
    return Date.now() - lastRun < cooldownSeconds * 1000
  }

  mark(hookFile: string, cwd: string): void {
    this.entries.set(this.key(hookFile, cwd), Date.now())
  }

  checkAndMark(hookFile: string, cooldownSeconds: number, cwd: string): boolean {
    if (this.isWithinCooldown(hookFile, cooldownSeconds, cwd)) return true
    this.mark(hookFile, cwd)
    return false
  }

  invalidateProject(cwd: string): void {
    for (const k of this.entries.keys()) {
      if (k.endsWith(`\x00${cwd}`)) this.entries.delete(k)
    }
  }

  invalidateAll(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}

export interface CachedGitState {
  status: GitBranchStatus
  cachedAt: number
}

export class GitStateCache {
  private entries = new Map<string, CachedGitState>()
  private inFlight = new Map<string, Promise<CachedGitState | null>>()

  async get(cwd: string): Promise<CachedGitState | null> {
    const cached = this.entries.get(cwd)
    if (cached) return cached
    const inflight = this.inFlight.get(cwd)
    if (inflight) return inflight
    const computation = getGitBranchStatus(cwd).then((status) => {
      this.inFlight.delete(cwd)
      if (!status) return null
      const entry: CachedGitState = { status, cachedAt: Date.now() }
      this.entries.set(cwd, entry)
      return entry
    })
    this.inFlight.set(cwd, computation)
    return computation
  }

  invalidateProject(cwd: string): void {
    this.entries.delete(cwd)
  }

  invalidateAll(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}

export interface CachedProjectSettings {
  settings: ProjectSwizSettings | null
  resolvedHooks: HookGroup[]
  warnings: string[]
  cachedAt: number
}

export class ProjectSettingsCache {
  private entries = new Map<string, CachedProjectSettings>()
  private inFlight = new Map<string, Promise<CachedProjectSettings>>()

  async get(cwd: string): Promise<CachedProjectSettings> {
    const cached = this.entries.get(cwd)
    if (cached) return cached
    const inflight = this.inFlight.get(cwd)
    if (inflight) return inflight
    const computation = readProjectSettings(cwd).then((settings) => {
      this.inFlight.delete(cwd)
      let resolvedHooks: HookGroup[] = []
      let warnings: string[] = []
      if (settings?.hooks?.length) {
        const result = resolveProjectHooks(settings.hooks, cwd)
        resolvedHooks = result.resolved
        warnings = result.warnings
      }
      const entry: CachedProjectSettings = {
        settings,
        resolvedHooks,
        warnings,
        cachedAt: Date.now(),
      }
      this.entries.set(cwd, entry)
      return entry
    })
    this.inFlight.set(cwd, computation)
    return computation
  }

  invalidateProject(cwd: string): void {
    this.entries.delete(cwd)
  }

  invalidateAll(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}

export interface CachedManifest {
  groups: HookGroup[]
  cachedAt: number
}

export class ManifestCache {
  private entries = new Map<string, CachedManifest>()
  private inFlight = new Map<string, Promise<HookGroup[]>>()
  private projectSettingsCache: ProjectSettingsCache

  constructor(projectSettingsCache: ProjectSettingsCache) {
    this.projectSettingsCache = projectSettingsCache
  }

  async get(cwd: string): Promise<HookGroup[]> {
    const cached = this.entries.get(cwd)
    if (cached) return cached.groups
    const inflight = this.inFlight.get(cwd)
    if (inflight) return inflight
    const computation = this.build(cwd).then((groups) => {
      this.entries.set(cwd, { groups, cachedAt: Date.now() })
      this.inFlight.delete(cwd)
      return groups
    })
    this.inFlight.set(cwd, computation)
    return computation
  }

  private async build(cwd: string): Promise<HookGroup[]> {
    const { manifest: builtinManifest } = await import("../../manifest.ts")
    const { loadAllPlugins } = await import("../../plugins.ts")
    let combined: HookGroup[] = [...builtinManifest]
    const cachedSettings = await this.projectSettingsCache.get(cwd)
    const projectSettings = cachedSettings.settings
    if (projectSettings?.plugins?.length) {
      const pluginResults = await loadAllPlugins(projectSettings.plugins, cwd)
      const pluginHooks = pluginResults.flatMap((r) => r.hooks)
      if (pluginHooks.length > 0) combined = [...combined, ...pluginHooks]
    }
    if (cachedSettings.resolvedHooks.length > 0) {
      combined = [...combined, ...cachedSettings.resolvedHooks]
    }
    return combined
  }

  invalidateProject(cwd: string): void {
    this.entries.delete(cwd)
  }

  invalidateAll(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}
