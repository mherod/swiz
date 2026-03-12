import { type FSWatcher, watch } from "node:fs"
import { dirname, join } from "node:path"
import { stderrLog } from "../debug.ts"
import { detectProjectStack } from "../detect-frameworks.ts"
import { resolvePrMergeActive, SWIZ_NOTIFY_HOOK_FILES } from "../dispatch/filters.ts"
import { type GitBranchStatus, getGitBranchStatus, ghJson } from "../git-helpers.ts"
import {
  getLaunchAgentPlistPath,
  loadLaunchAgent,
  SWIZ_DAEMON_LABEL,
  unloadLaunchAgent,
} from "../launch-agents.ts"
import { evalCondition, manifest } from "../manifest.ts"
import {
  getEffectiveSwizSettings,
  getProjectSettingsPath,
  getStatePath,
  getSwizSettingsPath,
  type ProjectSwizSettings,
  readProjectSettings,
  readProjectState,
  readSwizSettings,
  resolveProjectHooks,
} from "../settings.ts"
import { getWorkflowIntent } from "../state-machine.ts"
import { readTasks } from "../tasks/task-repository.ts"
import { getSessions } from "../tasks/task-resolver.ts"
import { parseTranscriptSummary, type TranscriptSummary } from "../transcript-summary.ts"
import {
  findAllProviderSessions,
  isHookFeedback,
  parseTranscriptEntries,
  type Session,
} from "../transcript-utils.ts"
import type { Command } from "../types.ts"
import {
  buildProjectTasksView,
  buildSessionTasksView,
  type CapturedToolCall,
  extractMessageText,
  extractToolCalls,
  mergeToolStats,
  type ProjectTaskPreview,
  restartDaemon,
  type SessionMessage,
  type SessionTaskPreview,
  type SessionTaskSummary,
  supplementMessagesWithCapturedToolCalls,
  transcriptWatchPathsForProject,
} from "./daemon/utils.ts"
import { startDaemonWebServer } from "./daemon/web-server.ts"
import { DaemonWorkerRuntime } from "./daemon/worker-runtime.ts"
import {
  computeWarmStatusLineSnapshot,
  getGhCachePath,
  type WarmStatusLineSnapshot,
} from "./status-line.ts"

const DAEMON_PORT = 7_943
const GITHUB_REFRESH_WINDOW_MS = 20_000
const CI_WATCH_POLL_MS = 30_000
const CI_WATCH_TIMEOUT_MS = 60 * 60 * 1000
const TRANSCRIPT_MEMORY_RETENTION_MS = 12 * 60 * 60 * 1000
const TRANSCRIPT_MEMORY_PRUNE_INTERVAL_MS = 5 * 60 * 1000

interface SnapshotFingerprint {
  git: string
  projectSettingsMtimeMs: number
  projectStateMtimeMs: number
  globalSettingsMtimeMs: number
  ghCacheMtimeMs: number
  githubBucket: number
}

export interface CachedSnapshot {
  snapshot: WarmStatusLineSnapshot
  fingerprint: SnapshotFingerprint
}

interface SessionPreview {
  id: string
  provider?: Session["provider"]
  format?: Session["format"]
  mtime: number
  startedAt?: number
  lastMessageAt?: number
  dispatches?: number
}

export interface ActiveHookDispatch {
  requestId: string
  canonicalEvent: string
  hookEventName: string
  cwd: string
  sessionId: string | null
  hooks: string[]
  startedAt: number
}

export interface CiWatchRun {
  databaseId: number
  status?: string | null
  conclusion?: string | null
  url?: string | null
}

export interface CiWatchStatus {
  sha: string
  cwd: string
  startedAt: number
  lastCheckedAt: number | null
  runId: number | null
  runUrl: string | null
}

type CiRunFetcher = (cwd: string, sha: string) => Promise<CiWatchRun | null>
type CiNotify = (watch: CiWatchStatus & { conclusion: string }) => Promise<void>

interface CiWatchInternal extends CiWatchStatus {
  deadlineAt: number
  timer: ReturnType<typeof setTimeout> | null
}

function ciWatchKey(cwd: string, sha: string): string {
  return `${cwd}\x00${sha}`
}

function resolveNotifyBinary(): string | null {
  const envBin = process.env.SWIZ_NOTIFY_BIN
  if (envBin?.trim()) return envBin

  const repoRoot = dirname(Bun.main)
  const devPath = join(repoRoot, "macos", "SwizNotify.app", "Contents", "MacOS", "swiz-notify")
  if (Bun.file(devPath).size > 0) return devPath

  const installed = "/usr/local/bin/swiz-notify"
  if (Bun.file(installed).size > 0) return installed

  return null
}

async function defaultCiCompletionNotify(
  watch: CiWatchStatus & { conclusion: string }
): Promise<void> {
  const binary = resolveNotifyBinary()
  if (!binary) return

  const sound = watch.conclusion === "success" ? "Hero" : "Bottle"
  const title = watch.conclusion === "success" ? "swiz CI passed" : "swiz CI failed"
  const body = watch.runUrl
    ? `${watch.sha.slice(0, 8)} • ${watch.runUrl}`
    : `${watch.sha.slice(0, 8)} • run ${watch.runId ?? "unknown"}`

  const proc = Bun.spawn(
    [binary, "--title", title, "--body", body, "--sound", sound, "--timeout", "20"],
    {
      stdout: "ignore",
      stderr: "ignore",
    }
  )
  await proc.exited
}

async function defaultCiRunFetcher(cwd: string, sha: string): Promise<CiWatchRun | null> {
  const runs = await ghJson<CiWatchRun[]>(
    ["run", "list", "--commit", sha, "--json", "databaseId,status,conclusion,url", "--limit", "1"],
    cwd
  )
  if (!Array.isArray(runs) || runs.length === 0) return null
  return runs[0] ?? null
}

export class CiWatchRegistry {
  private watches = new Map<string, CiWatchInternal>()
  private pollMs: number
  private timeoutMs: number
  private fetchRun: CiRunFetcher
  private notify: CiNotify

  constructor(
    opts: {
      pollMs?: number
      timeoutMs?: number
      fetchRun?: CiRunFetcher
      notify?: CiNotify
    } = {}
  ) {
    this.pollMs = opts.pollMs ?? CI_WATCH_POLL_MS
    this.timeoutMs = opts.timeoutMs ?? CI_WATCH_TIMEOUT_MS
    this.fetchRun = opts.fetchRun ?? defaultCiRunFetcher
    this.notify = opts.notify ?? defaultCiCompletionNotify
  }

  listActive(): CiWatchStatus[] {
    return [...this.watches.values()].map((w) => ({
      sha: w.sha,
      cwd: w.cwd,
      startedAt: w.startedAt,
      lastCheckedAt: w.lastCheckedAt,
      runId: w.runId,
      runUrl: w.runUrl,
    }))
  }

  start(cwd: string, sha: string): { deduped: boolean; watch: CiWatchStatus } {
    const key = ciWatchKey(cwd, sha)
    const existing = this.watches.get(key)
    if (existing) {
      return {
        deduped: true,
        watch: {
          sha: existing.sha,
          cwd: existing.cwd,
          startedAt: existing.startedAt,
          lastCheckedAt: existing.lastCheckedAt,
          runId: existing.runId,
          runUrl: existing.runUrl,
        },
      }
    }

    const watch: CiWatchInternal = {
      sha,
      cwd,
      startedAt: Date.now(),
      lastCheckedAt: null,
      runId: null,
      runUrl: null,
      deadlineAt: Date.now() + this.timeoutMs,
      timer: null,
    }
    this.watches.set(key, watch)
    this.schedulePoll(key)

    return {
      deduped: false,
      watch: {
        sha: watch.sha,
        cwd: watch.cwd,
        startedAt: watch.startedAt,
        lastCheckedAt: watch.lastCheckedAt,
        runId: watch.runId,
        runUrl: watch.runUrl,
      },
    }
  }

  close(): void {
    for (const watch of this.watches.values()) {
      if (watch.timer) clearTimeout(watch.timer)
      watch.timer = null
    }
    this.watches.clear()
  }

  private schedulePoll(key: string): void {
    const watch = this.watches.get(key)
    if (!watch) return
    watch.timer = setTimeout(() => {
      void this.poll(key)
    }, this.pollMs)
  }

  private async poll(key: string): Promise<void> {
    const watch = this.watches.get(key)
    if (!watch) return

    if (Date.now() > watch.deadlineAt) {
      this.watches.delete(key)
      await this.notify({ ...watch, conclusion: "timeout" })
      return
    }

    watch.lastCheckedAt = Date.now()
    const run = await this.fetchRun(watch.cwd, watch.sha)
    if (run?.databaseId) {
      watch.runId = run.databaseId
      watch.runUrl = run.url ?? null
      const status = (run.status ?? "").toLowerCase()
      if (status === "completed") {
        const conclusion = (run.conclusion ?? "unknown").toLowerCase()
        this.watches.delete(key)
        await this.notify({ ...watch, conclusion })
        return
      }
    }

    this.schedulePoll(key)
  }
}

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

export function serializeMetrics(metrics: DaemonMetrics) {
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
              /* ignore callback errors */
            }
          }
        })
      } catch {
        /* path may not exist yet — that's fine */
      }
    }
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
  private entries = new Map<string, GhCacheEntry>()
  private fetcher: GhFetcher

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
      return { hit: true, value: entry.value }
    }
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
}

// ─── Hook eligibility precomputation ──────────────────────────────────────

/**
 * Serializable snapshot of precomputed hook eligibility for a project.
 * Captures all the decisions that `applyHookSettingFilters` would make
 * so that dispatch can skip the cold-path computation.
 */
export interface EligibilitySnapshot {
  /** Hook files that should be disabled (from settings + notifications + PR mode). */
  disabledHooks: string[]
  /** Detected project stacks (e.g. ["bun"]). */
  detectedStacks: string[]
  /** Whether PR-merge-mode hooks are active. */
  prMergeActive: boolean
  /** Workflow intent from project state (null if no state). */
  workflowIntent: string | null
  /** Per-hook condition results: hookFile → true (run) / false (skip). */
  conditionResults: Record<string, boolean>
  /** Timestamp when this snapshot was computed. */
  computedAt: number
}

export class HookEligibilityCache {
  private entries = new Map<string, EligibilitySnapshot>()

  async compute(cwd: string): Promise<EligibilitySnapshot> {
    const cached = this.entries.get(cwd)
    if (cached) return cached

    const snapshot = await computeEligibility(cwd)
    this.entries.set(cwd, snapshot)
    return snapshot
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

async function computeEligibility(cwd: string): Promise<EligibilitySnapshot> {
  const settings = await readSwizSettings()
  const projectSettings = cwd ? await readProjectSettings(cwd) : null
  const effective = getEffectiveSwizSettings(settings, null)

  // Build disabled set (same logic as applyHookSettingFilters)
  const disabledSet = new Set([
    ...(settings.disabledHooks ?? []),
    ...(projectSettings?.disabledHooks ?? []),
  ])
  if (!effective.swizNotifyHooks) {
    for (const file of SWIZ_NOTIFY_HOOK_FILES) disabledSet.add(file)
  }

  const detectedStacks = cwd ? detectProjectStack(cwd) : []
  const prMergeActive = resolvePrMergeActive(effective.collaborationMode, effective.prMergeMode)

  // Workflow intent from project state
  let workflowIntent: string | null = null
  try {
    const state = await readProjectState(cwd)
    if (state) {
      workflowIntent = getWorkflowIntent(state)
    }
  } catch {
    // State reading failures → no state filtering
  }

  // Evaluate conditions for all manifest hooks
  const conditionResults: Record<string, boolean> = {}
  for (const group of manifest) {
    for (const hook of group.hooks) {
      if (hook.condition && !(hook.file in conditionResults)) {
        conditionResults[hook.file] = evalCondition(hook.condition)
      }
    }
  }

  // Also evaluate conditions for project-local hooks
  if (projectSettings?.hooks?.length) {
    const { resolved } = resolveProjectHooks(projectSettings.hooks, cwd)
    for (const group of resolved) {
      for (const hook of group.hooks) {
        if (hook.condition && !(hook.file in conditionResults)) {
          conditionResults[hook.file] = evalCondition(hook.condition)
        }
      }
    }
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

// ─── Transcript index cache ───────────────────────────────────────────────

/**
 * Cached transcript index entry. Stores a pre-parsed TranscriptSummary
 * plus derived artifacts, keyed by file path and validated by mtime.
 */
export interface TranscriptIndex {
  summary: TranscriptSummary
  /** tool_use IDs that were blocked by PreToolUse hooks. */
  blockedToolUseIds: string[]
  /** File mtime when this index was computed. */
  mtimeMs: number
  /** Timestamp when this index was computed. */
  computedAt: number
}

export class TranscriptIndexCache {
  private entries = new Map<string, TranscriptIndex>()

  async get(transcriptPath: string): Promise<TranscriptIndex | null> {
    try {
      const file = Bun.file(transcriptPath)
      const stat = await file.stat()
      const mtimeMs = stat.mtimeMs ?? 0

      const cached = this.entries.get(transcriptPath)
      if (cached && cached.mtimeMs === mtimeMs) {
        cached.computedAt = Date.now()
        return cached
      }

      const text = await file.text()
      const summary = parseTranscriptSummary(text)

      // Collect blocked tool_use IDs from session lines
      const blockedIds: string[] = []
      for (const line of summary.sessionLines) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as {
            type?: string
            message?: { content?: string | unknown[] }
          }
          if (entry?.type !== "user") continue
          const content = entry?.message?.content
          if (!Array.isArray(content)) continue
          for (const block of content as Array<{
            type?: string
            content?: string | unknown[]
            tool_use_id?: string
          }>) {
            if (block?.type !== "tool_result") continue
            const blockContent = block.content
            const text =
              typeof blockContent === "string"
                ? blockContent
                : Array.isArray(blockContent)
                  ? (blockContent as Array<{ text?: string }>)
                      .map((c) => (typeof c === "string" ? c : (c?.text ?? "")))
                      .join("")
                  : ""
            if (text.includes("ACTION REQUIRED:")) {
              blockedIds.push(String(block.tool_use_id ?? ""))
            }
          }
        } catch {
          // ignore malformed lines
        }
      }

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

  invalidateAll(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }

  pruneOlderThan(cutoffMs: number): void {
    for (const [path, entry] of this.entries) {
      if (entry.computedAt < cutoffMs) this.entries.delete(path)
    }
  }
}

// ─── In-memory hook cooldown tracking ─────────────────────────────────────

/**
 * In-memory cooldown registry for daemon-backed dispatches.
 * Replaces file-based sentinel reads/writes on the hot path.
 * Keyed by `hookFile\0cwd` — same logical scope as `hookCooldownPath`.
 *
 * On daemon restart all cooldowns reset (intentional: daemon lifetime
 * is the cache lifetime, same as GhQueryCache).
 */
export class CooldownRegistry {
  private entries = new Map<string, number>()

  private key(hookFile: string, cwd: string): string {
    return `${hookFile}\x00${cwd}`
  }

  /** Check whether a hook is within its cooldown window. */
  isWithinCooldown(hookFile: string, cooldownSeconds: number, cwd: string): boolean {
    const lastRun = this.entries.get(this.key(hookFile, cwd))
    if (lastRun === undefined) return false
    return Date.now() - lastRun < cooldownSeconds * 1000
  }

  /** Record that a hook just ran (sets the cooldown start to now). */
  mark(hookFile: string, cwd: string): void {
    this.entries.set(this.key(hookFile, cwd), Date.now())
  }

  /** Check cooldown and mark in one call. Returns true if within cooldown. */
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

// ─── Warm git state cache ─────────────────────────────────────────────────

/**
 * Cached git state for a project. Wraps `GitBranchStatus` with a timestamp
 * so consumers can tell how fresh the data is.
 */
export interface CachedGitState {
  status: GitBranchStatus
  cachedAt: number
}

/**
 * Per-project cache of `getGitBranchStatus()` results. The daemon
 * invalidates entries when `.git/` changes are detected by the
 * `FileWatcherRegistry`, so hook dispatches can read branch/status/divergence
 * without spawning `git status` on every request.
 */
export class GitStateCache {
  private entries = new Map<string, CachedGitState>()

  /** Get cached git state, computing it if missing. */
  async get(cwd: string): Promise<CachedGitState | null> {
    const cached = this.entries.get(cwd)
    if (cached) return cached

    const status = await getGitBranchStatus(cwd)
    if (!status) return null

    const entry: CachedGitState = { status, cachedAt: Date.now() }
    this.entries.set(cwd, entry)
    return entry
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

// ─── Project settings cache ───────────────────────────────────────────────

/**
 * Cached project settings and resolved hook groups for a single project.
 */
export interface CachedProjectSettings {
  settings: ProjectSwizSettings | null
  resolvedHooks: import("../manifest.ts").HookGroup[]
  warnings: string[]
  cachedAt: number
}

/**
 * Per-project cache of `readProjectSettings()` + `resolveProjectHooks()`.
 * Avoids re-reading `.swiz/config.json` and re-running `existsSync` checks
 * on every dispatch. Invalidated when the project settings file changes.
 */
export class ProjectSettingsCache {
  private entries = new Map<string, CachedProjectSettings>()

  async get(cwd: string): Promise<CachedProjectSettings> {
    const cached = this.entries.get(cwd)
    if (cached) return cached

    const settings = await readProjectSettings(cwd)
    let resolvedHooks: import("../manifest.ts").HookGroup[] = []
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

// ─── Combined manifest cache ──────────────────────────────────────────────

/**
 * Cached combined manifest for a project — includes the built-in manifest,
 * plugin hook groups, and resolved project-local hooks. Eliminates redundant
 * file I/O and plugin loading on repeated daemon dispatches for the same cwd.
 */
export interface CachedManifest {
  groups: import("../manifest.ts").HookGroup[]
  cachedAt: number
}

export class ManifestCache {
  private entries = new Map<string, CachedManifest>()
  private projectSettingsCache: ProjectSettingsCache

  constructor(projectSettingsCache: ProjectSettingsCache) {
    this.projectSettingsCache = projectSettingsCache
  }

  async get(cwd: string): Promise<import("../manifest.ts").HookGroup[]> {
    const cached = this.entries.get(cwd)
    if (cached) return cached.groups

    const groups = await this.build(cwd)
    this.entries.set(cwd, { groups, cachedAt: Date.now() })
    return groups
  }

  private async build(cwd: string): Promise<import("../manifest.ts").HookGroup[]> {
    const { manifest: builtinManifest } = await import("../manifest.ts")
    const { loadAllPlugins } = await import("../plugins.ts")

    let combined: import("../manifest.ts").HookGroup[] = [...builtinManifest]
    const cachedSettings = await this.projectSettingsCache.get(cwd)
    const projectSettings = cachedSettings.settings

    if (projectSettings?.plugins?.length) {
      const pluginResults = await loadAllPlugins(projectSettings.plugins, cwd)
      const pluginHooks = pluginResults.flatMap((r) => r.hooks)
      if (pluginHooks.length > 0) {
        combined = [...combined, ...pluginHooks]
      }
    }

    // Use cached resolved hooks from ProjectSettingsCache
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

export function hasSnapshotInvalidated(
  previous: SnapshotFingerprint | null,
  next: SnapshotFingerprint
): boolean {
  if (!previous) return true
  return (
    previous.git !== next.git ||
    previous.projectSettingsMtimeMs !== next.projectSettingsMtimeMs ||
    previous.projectStateMtimeMs !== next.projectStateMtimeMs ||
    previous.globalSettingsMtimeMs !== next.globalSettingsMtimeMs ||
    previous.ghCacheMtimeMs !== next.ghCacheMtimeMs ||
    previous.githubBucket !== next.githubBucket
  )
}

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

function messageFallbackKey(message: SessionMessage, occurrence: number): string {
  const toolSig = (message.toolCalls ?? []).map((tc) => `${tc.name}:${tc.detail}`).join("|")
  return `${message.role}\x00${message.text}\x00${toolSig}\x00${occurrence}`
}

class SessionDataCache {
  private entries = new Map<string, CachedSessionData>()

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

const sessionDataCache = new SessionDataCache()

export { DaemonWorkerRuntime } from "./daemon/worker-runtime.ts"

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

interface SessionData {
  messages: SessionMessage[]
  toolStats: Array<{ name: string; count: number }>
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

async function safeMtime(path: string | null): Promise<number> {
  if (!path) return 0
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) return 0
    const info = await file.stat()
    return info.mtimeMs ?? 0
  } catch {
    return 0
  }
}

async function buildSnapshotFingerprint(cwd: string): Promise<SnapshotFingerprint> {
  const gitStatus = await getGitBranchStatus(cwd)
  const globalSettingsPath = getSwizSettingsPath()
  return {
    git: gitStatus ? JSON.stringify(gitStatus) : "not-git",
    projectSettingsMtimeMs: await safeMtime(getProjectSettingsPath(cwd)),
    projectStateMtimeMs: await safeMtime(getStatePath(cwd)),
    globalSettingsMtimeMs: await safeMtime(globalSettingsPath),
    ghCacheMtimeMs: await safeMtime(getGhCachePath(cwd)),
    githubBucket: Math.floor(Date.now() / GITHUB_REFRESH_WINDOW_MS),
  }
}

function buildPlist(port: number): string {
  const bunPath = Bun.which("bun") ?? "/opt/homebrew/bin/bun"
  const projectRoot = dirname(Bun.main)
  const indexPath = join(projectRoot, "index.ts")
  const daemonTs = join(projectRoot, "src", "commands", "daemon.ts")

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SWIZ_DAEMON_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>(sleep 1200 &amp;&amp; kill $$) &amp; exec ${bunPath} --watch ${indexPath} daemon --port ${port}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${projectRoot}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StartInterval</key>
  <integer>1200</integer>

  <key>StandardOutPath</key>
  <string>/tmp/swiz-daemon.log</string>

  <key>StandardErrorPath</key>
  <string>/tmp/swiz-daemon.log</string>

  <key>WatchPaths</key>
  <array>
    <string>${daemonTs}</string>
    <string>${indexPath}</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>`
}

async function install(port: number) {
  const plist = buildPlist(port)
  const plistPath = getLaunchAgentPlistPath(SWIZ_DAEMON_LABEL)
  await Bun.write(plistPath, plist)
  console.log(`Wrote ${plistPath}`)

  const loadExitCode = await loadLaunchAgent(plistPath)
  if (loadExitCode !== 0) {
    throw new Error("launchctl load failed")
  }
  console.log(`Loaded ${SWIZ_DAEMON_LABEL}`)
}

async function uninstall() {
  const plistPath = getLaunchAgentPlistPath(SWIZ_DAEMON_LABEL)
  await unloadLaunchAgent(plistPath)

  const file = Bun.file(plistPath)
  if (await file.exists()) {
    const rm = Bun.spawn(["trash", plistPath], {
      stdout: "inherit",
      stderr: "inherit",
    })
    await rm.exited
    console.log(`Removed ${plistPath}`)
  }
  console.log(`Unloaded ${SWIZ_DAEMON_LABEL}`)
}

async function fetchDaemonStatus(port: number): Promise<void> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/metrics`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!resp.ok) {
      stderrLog("daemon-status", `Daemon returned ${resp.status}`)
      process.exitCode = 1
      return
    }
    const data = (await resp.json()) as {
      uptimeHuman: string
      totalDispatches: number
      byEvent: Record<string, { count: number; avgMs: number }>
      projects?: Record<
        string,
        {
          uptimeHuman: string
          totalDispatches: number
          byEvent: Record<string, { count: number; avgMs: number }>
        }
      >
    }
    console.log(`Daemon uptime: ${data.uptimeHuman}`)
    console.log(`Total dispatches: ${data.totalDispatches}`)
    const events = Object.entries(data.byEvent)
    if (events.length > 0) {
      console.log("\nDispatches by event:")
      for (const [event, m] of events.sort((a, b) => b[1].count - a[1].count)) {
        console.log(`  ${event}: ${m.count} (avg ${m.avgMs}ms)`)
      }
    }
    if (data.projects) {
      const projectEntries = Object.entries(data.projects)
      if (projectEntries.length > 0) {
        console.log(`\nProjects: ${projectEntries.length}`)
        for (const [cwd, pm] of projectEntries) {
          console.log(`  ${cwd}: ${pm.totalDispatches} dispatches`)
        }
      }
    }
  } catch {
    stderrLog("daemon-status", `Daemon not reachable on port ${port}`)
    process.exitCode = 1
  }
}

export const daemonCommand: Command = {
  name: "daemon",
  description: "Run a background web server",
  usage: "swiz daemon [--port <port>] [--restart] [--install] [--uninstall] [status]",
  options: [
    { flags: "--port <port>", description: "Port to listen on (default: 7943)" },
    { flags: "--restart", description: "Stop any daemon on the port, then start fresh" },
    { flags: "--install", description: "Install as a LaunchAgent" },
    { flags: "--uninstall", description: "Uninstall the LaunchAgent" },
    { flags: "status", description: "Show daemon metrics and status" },
  ],
  async run(args) {
    const portIndex = args.indexOf("--port")
    const port = portIndex !== -1 ? Number(args[portIndex + 1]) : DAEMON_PORT

    if (args.includes("status")) {
      await fetchDaemonStatus(port)
      return
    }

    if (args.includes("--install")) {
      await install(port)
      return
    }

    if (args.includes("--uninstall")) {
      await uninstall()
      return
    }

    if (args.includes("--restart")) {
      const restarted = await restartDaemon(port, process.pid)
      if (restarted.mode === "launchagent") {
        const runningMsg = restarted.hadRunning ? "reloaded" : "loaded"
        console.log(`${SWIZ_DAEMON_LABEL} ${runningMsg} via launchctl.`)
        return
      }
      if (!restarted.hadRunning) console.log(`No daemon detected on port ${port}; starting fresh.`)
      else
        console.log(
          `Restarting daemon on port ${port} (stopped ${restarted.stoppedCount} process${restarted.stoppedCount === 1 ? "" : "es"}).`
        )
    }

    const globalMetrics = createMetrics()
    const projectMetrics = new Map<string, DaemonMetrics>()
    const projectLastSeen = new Map<string, number>()
    /** Tracks the latest dispatch timestamp per session ID (from hook events). */
    const sessionActivity = new Map<string, { lastSeen: number; dispatches: number }>()
    /** Per-session tool calls captured from hook dispatch payloads. */
    const sessionToolCalls = new Map<string, CapturedToolCall[]>()
    /** In-flight hook dispatches currently being processed by daemon /dispatch. */
    const activeHookDispatches = new Map<string, ActiveHookDispatch>()
    let lastTranscriptMemoryPruneAt = 0
    const getProjectMetrics = (cwd: string): DaemonMetrics => {
      let m = projectMetrics.get(cwd)
      if (!m) {
        m = createMetrics()
        projectMetrics.set(cwd, m)
      }
      return m
    }
    const touchProject = (cwd: string) => {
      projectLastSeen.set(cwd, Date.now())
    }
    const pruneTranscriptMemory = () => {
      const now = Date.now()
      if (now - lastTranscriptMemoryPruneAt < TRANSCRIPT_MEMORY_PRUNE_INTERVAL_MS) return
      lastTranscriptMemoryPruneAt = now
      const cutoffMs = now - TRANSCRIPT_MEMORY_RETENTION_MS
      sessionDataCache.pruneOlderThan(cutoffMs)
      transcriptIndex.pruneOlderThan(cutoffMs)
      for (const [sessionId, activity] of sessionActivity) {
        if (activity.lastSeen < cutoffMs) sessionActivity.delete(sessionId)
      }
      for (const [sessionId, toolCalls] of sessionToolCalls) {
        const recent = toolCalls.filter((call) => new Date(call.timestamp).getTime() >= cutoffMs)
        if (recent.length === 0) {
          sessionToolCalls.delete(sessionId)
          continue
        }
        if (recent.length !== toolCalls.length) {
          sessionToolCalls.set(sessionId, recent)
        }
      }
    }
    touchProject(process.cwd())

    const watchers = new FileWatcherRegistry()
    const ghCache = new GhQueryCache()
    const eligibilityCache = new HookEligibilityCache()
    const transcriptIndex = new TranscriptIndexCache()
    const cooldownRegistry = new CooldownRegistry()
    const ciWatchRegistry = new CiWatchRegistry()
    const workerRuntime = new DaemonWorkerRuntime()
    const gitStateCache = new GitStateCache()
    const projectSettingsCache = new ProjectSettingsCache()
    const manifestCache = new ManifestCache(projectSettingsCache)
    const projectRoot = dirname(Bun.main)
    const hooksDir = join(projectRoot, "hooks/")
    const manifestPath = join(projectRoot, "src", "manifest.ts")
    const globalSettingsPath = getSwizSettingsPath()

    const snapshots = new Map<string, CachedSnapshot>()
    const cacheKey = (cwd: string, sessionId: string | null | undefined) =>
      `${cwd}\x00${sessionId ?? ""}`
    const resolveSnapshot = async (
      cwd: string,
      sessionId: string | null | undefined
    ): Promise<WarmStatusLineSnapshot> => {
      const key = cacheKey(cwd, sessionId)
      const nextFingerprint = await buildSnapshotFingerprint(cwd)
      const existing = snapshots.get(key)
      if (existing && !hasSnapshotInvalidated(existing.fingerprint, nextFingerprint)) {
        return existing.snapshot
      }
      const snapshot = await computeWarmStatusLineSnapshot(cwd, sessionId)
      snapshots.set(key, { snapshot, fingerprint: nextFingerprint })
      return snapshot
    }

    // Register watchers for cache invalidation
    const flushSnapshots = () => {
      snapshots.clear()
      ghCache.invalidateAll()
      eligibilityCache.invalidateAll()
      gitStateCache.invalidateAll()
      projectSettingsCache.invalidateAll()
      manifestCache.invalidateAll()
    }

    watchers.register(manifestPath, "manifest", flushSnapshots)
    watchers.register(hooksDir, "hooks", flushSnapshots)
    if (globalSettingsPath) {
      watchers.register(globalSettingsPath, "global-settings", flushSnapshots)
    }

    const registeredProjects = new Set<string>()
    const registerProjectWatchers = (cwd: string) => {
      if (registeredProjects.has(cwd)) return
      registeredProjects.add(cwd)
      const projectFlush = () => {
        // Flush snapshots, gh cache, eligibility, git state, and manifest for this project
        for (const key of snapshots.keys()) {
          if (key.startsWith(cwd)) snapshots.delete(key)
        }
        ghCache.invalidateProject(cwd)
        eligibilityCache.invalidateProject(cwd)
        gitStateCache.invalidateProject(cwd)
        projectSettingsCache.invalidateProject(cwd)
        manifestCache.invalidateProject(cwd)
        // Transcript/session caches are path-based and can include multiple providers.
        // Clear on project-related watcher events to avoid stale ordering/message views.
        transcriptIndex.invalidateAll()
        sessionDataCache.invalidateAll()
      }
      const projectSettings = getProjectSettingsPath(cwd)
      if (projectSettings)
        watchers.register(projectSettings, `project-settings:${cwd}`, projectFlush)
      const gitDir = join(cwd, ".git/")
      watchers.register(gitDir, `git:${cwd}`, projectFlush)
      for (const transcriptWatch of transcriptWatchPathsForProject(cwd)) {
        watchers.register(transcriptWatch.path, transcriptWatch.label, projectFlush)
      }
      // Re-start to pick up new watchers
      watchers.start()
    }

    watchers.start()
    process.on("exit", () => {
      watchers.close()
      ciWatchRegistry.close()
      workerRuntime.close()
    })

    const server = startDaemonWebServer({
      port,
      pruneTranscriptMemory,
      transcriptIndex,
      manifestCache,
      globalMetrics,
      getProjectMetrics,
      touchProject,
      registerProjectWatchers,
      sessionActivity,
      sessionToolCalls,
      activeHookDispatches,
      projectMetrics,
      ghCache,
      eligibilityCache,
      cooldownRegistry,
      gitStateCache,
      ciWatchRegistry,
      projectSettingsCache,
      registeredProjects,
      projectLastSeen,
      resolveSnapshot,
      watchers,
      snapshots,
      workerRuntime,
    })

    console.log(`Daemon listening on ${server.url}`)
  },
}
