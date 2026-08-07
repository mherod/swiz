/**
 * Structured JSONL logging for hook dispatch events.
 *
 * Appends and maintenance share a cross-process lock. The daemon periodically
 * compacts the active file to configurable byte and age limits while retaining
 * at least the most recent 10,000 valid records.
 */

import { appendFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getHomeDirOrNull } from "./home.ts"
import { getLockPathForFile, withFileLock } from "./utils/file-lock.ts"
import {
  readJsonlTailText,
  splitJsonlLines,
  tryParseJsonLine,
  writeJsonlTextAtomically,
} from "./utils/jsonl.ts"

export interface HookLogEntry {
  ts: string
  event: string
  hookEventName: string
  hook: string
  status: string
  durationMs: number
  exitCode: number | null
  matcher?: string
  sessionId?: string
  cwd?: string
  toolName?: string
  skipReason?: string
  stdoutSnippet?: string
  stderrSnippet?: string
  /** "hook" (default) for individual hook runs, "dispatch" for overall dispatch summary */
  kind?: "hook" | "dispatch"
  /** Number of hooks executed in this dispatch (only set when kind === "dispatch") */
  hookCount?: number
}

export const MIN_HOOK_LOG_RECORDS = 10_000
export const DEFAULT_HOOK_LOG_MAX_BYTES = 32 * 1024 * 1024
export const DEFAULT_HOOK_LOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const DEFAULT_HOOK_LOG_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000
const HOOK_LOG_COMPACTION_TARGET_RATIO = 0.75
const HOOK_LOG_MAINTENANCE_TRIGGER_RATIO = 0.9

export interface HookLogConfig {
  logPath: string
  maxBytes: number
  maxAgeMs: number
  minRecords: number
}

export interface HookLogMetrics {
  appendErrors: number
  currentBytes: number
  lastMaintenanceAt: string | null
  lastMaintenanceDurationMs: number
  lastMaintenanceResult: "never" | "missing" | "unchanged" | "compacted" | "error"
  maxAgeMs: number
  maxBytes: number
  retainedRecords: number
}

interface RetainedLine {
  line: string
  timestampMs: number
  bytes: number
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function getLogPath(): string | null {
  const home = getHomeDirOrNull()
  if (!home) return null
  return join(home, ".swiz", "hook-logs.jsonl")
}

export function resolveHookLogConfig(
  logPath: string,
  env: Record<string, string | undefined> = process.env
): HookLogConfig {
  const maxAgeDays = positiveInteger(env.SWIZ_HOOK_LOG_MAX_AGE_DAYS, 30)
  return {
    logPath,
    maxBytes: positiveInteger(env.SWIZ_HOOK_LOG_MAX_BYTES, DEFAULT_HOOK_LOG_MAX_BYTES),
    maxAgeMs: maxAgeDays * 24 * 60 * 60 * 1000,
    minRecords: MIN_HOOK_LOG_RECORDS,
  }
}

function parseRetainedLines(text: string): RetainedLine[] {
  const encoder = new TextEncoder()
  const records: RetainedLine[] = []
  for (const line of splitJsonlLines(text)) {
    const parsed = tryParseJsonLine(line) as HookLogEntry | undefined
    if (!parsed) continue
    const timestampMs = Date.parse(parsed.ts)
    records.push({
      line,
      timestampMs: Number.isFinite(timestampMs) ? timestampMs : 0,
      bytes: encoder.encode(`${line}\n`).byteLength,
    })
  }
  return records
}

function selectRetainedLines(
  records: RetainedLine[],
  config: HookLogConfig,
  now: number
): RetainedLine[] {
  const cutoffMs = now - config.maxAgeMs
  const targetBytes = Math.floor(config.maxBytes * HOOK_LOG_COMPACTION_TARGET_RATIO)
  const retained: RetainedLine[] = []
  let retainedBytes = 0

  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]!
    const mandatory = retained.length < config.minRecords
    const recent = record.timestampMs >= cutoffMs
    const fits = retainedBytes + record.bytes <= targetBytes
    if (!mandatory && (!recent || !fits)) break
    retained.push(record)
    retainedBytes += record.bytes
  }

  retained.reverse()
  return retained
}

async function readMaintenanceWindow(
  config: HookLogConfig
): Promise<{ fileSize: number; reachedStart: boolean; records: RetainedLine[] } | null> {
  let initialBytes = Math.min(config.maxBytes, 1024 * 1024)
  while (true) {
    const result = await readJsonlTailText(config.logPath, {
      initialBytes,
      isEnough: (text, meta) =>
        splitJsonlLines(text).length >= config.minRecords &&
        meta.bytesRead >= Math.min(meta.fileSize, config.maxBytes),
    })
    if (!result) return null
    const records = parseRetainedLines(result.text)
    if (records.length >= config.minRecords || result.reachedStart) {
      return { fileSize: result.fileSize, reachedStart: result.reachedStart, records }
    }
    initialBytes = Math.min(result.fileSize + 1, Math.max(initialBytes * 2, result.bytesRead * 2))
  }
}

export class HookLogStore {
  private operationTail: Promise<void> = Promise.resolve()
  private maintenanceQueued = false
  private readonly lockPath: string
  private readonly metrics: HookLogMetrics

  constructor(private readonly config: HookLogConfig) {
    this.lockPath = getLockPathForFile(config.logPath)
    this.metrics = {
      appendErrors: 0,
      currentBytes: 0,
      lastMaintenanceAt: null,
      lastMaintenanceDurationMs: 0,
      lastMaintenanceResult: "never",
      maxAgeMs: config.maxAgeMs,
      maxBytes: config.maxBytes,
      retainedRecords: 0,
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationTail.then(operation, operation)
    this.operationTail = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  append(entries: HookLogEntry[]): Promise<void> {
    if (entries.length === 0) return Promise.resolve()
    const newLines = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`

    const write = this.enqueue(async () => {
      try {
        await withFileLock(this.lockPath, async () => {
          await mkdir(dirname(this.config.logPath), { recursive: true })
          await appendFile(this.config.logPath, newLines)
          this.metrics.currentBytes = (await Bun.file(this.config.logPath).stat()).size
          if (
            this.metrics.lastMaintenanceResult !== "never" &&
            this.metrics.lastMaintenanceResult !== "error"
          ) {
            this.metrics.retainedRecords += entries.length
          }
        })
      } catch {
        this.metrics.appendErrors += 1
      }
    })
    void write.then(() => this.scheduleMaintenanceIfNeeded())
    return write
  }

  private scheduleMaintenanceIfNeeded(): void {
    const triggerBytes = this.config.maxBytes * HOOK_LOG_MAINTENANCE_TRIGGER_RATIO
    if (this.metrics.currentBytes < triggerBytes || this.maintenanceQueued) return
    this.maintenanceQueued = true
    void this.maintain().finally(() => {
      this.maintenanceQueued = false
    })
  }

  read(limit = 200): Promise<HookLogEntry[]> {
    return this.enqueue(async () => {
      try {
        const result = await readJsonlTailText(this.config.logPath, {
          isEnough: (text) => splitJsonlLines(text).length >= limit,
        })
        if (!result) return []
        const recent = splitJsonlLines(result.text).slice(-limit)
        const entries: HookLogEntry[] = []
        for (const line of recent) {
          const parsed = tryParseJsonLine(line) as HookLogEntry | undefined
          if (parsed) entries.push(parsed)
        }
        return entries
      } catch {
        return []
      }
    })
  }

  maintain(now = Date.now()): Promise<HookLogMetrics> {
    return this.enqueue(async () => {
      const startedAt = performance.now()
      this.metrics.lastMaintenanceAt = new Date(now).toISOString()
      try {
        await withFileLock(this.lockPath, async () => {
          const window = await readMaintenanceWindow(this.config)
          if (!window) {
            this.metrics.currentBytes = 0
            this.metrics.retainedRecords = 0
            this.metrics.lastMaintenanceResult = "missing"
            return
          }

          const retained = selectRetainedLines(window.records, this.config, now)
          const retainedText = retained.map((record) => record.line).join("\n")
          const output = retainedText ? `${retainedText}\n` : ""
          const outputBytes = new TextEncoder().encode(output).byteLength
          const unchanged =
            window.reachedStart &&
            outputBytes === window.fileSize &&
            retained.length === window.records.length

          if (!unchanged) await writeJsonlTextAtomically(this.config.logPath, output)
          this.metrics.currentBytes = outputBytes
          this.metrics.retainedRecords = retained.length
          this.metrics.lastMaintenanceResult = unchanged ? "unchanged" : "compacted"
        })
      } catch {
        this.metrics.lastMaintenanceResult = "error"
      } finally {
        this.metrics.lastMaintenanceDurationMs = Number((performance.now() - startedAt).toFixed(2))
      }
      return this.getMetrics()
    })
  }

  getMetrics(): HookLogMetrics {
    return { ...this.metrics }
  }
}

let defaultStore: HookLogStore | null = null
let defaultStorePath: string | null = null

function getDefaultStore(): HookLogStore | null {
  const logPath = getLogPath()
  if (!logPath) return null
  if (!defaultStore || defaultStorePath !== logPath) {
    defaultStore = new HookLogStore(resolveHookLogConfig(logPath))
    defaultStorePath = logPath
  }
  return defaultStore
}

export async function appendHookLog(entry: HookLogEntry): Promise<void> {
  return appendHookLogs([entry])
}

export async function appendHookLogs(entries: HookLogEntry[]): Promise<void> {
  await getDefaultStore()?.append(entries)
}

export async function readHookLogs(limit = 200): Promise<HookLogEntry[]> {
  return (await getDefaultStore()?.read(limit)) ?? []
}

export async function maintainHookLogs(now = Date.now()): Promise<HookLogMetrics | null> {
  return (await getDefaultStore()?.maintain(now)) ?? null
}

export function getHookLogMetrics(): HookLogMetrics | null {
  return getDefaultStore()?.getMetrics() ?? null
}

export function startHookLogMaintenance(
  env: Record<string, string | undefined> = process.env
): () => void {
  let maintenanceRunning = false
  const runMaintenance = () => {
    if (maintenanceRunning) return
    maintenanceRunning = true
    void maintainHookLogs().finally(() => {
      maintenanceRunning = false
    })
  }
  runMaintenance()
  const interval = setInterval(
    runMaintenance,
    positiveInteger(
      env.SWIZ_HOOK_LOG_MAINTENANCE_INTERVAL_MS,
      DEFAULT_HOOK_LOG_MAINTENANCE_INTERVAL_MS
    )
  )
  interval.unref()
  return () => clearInterval(interval)
}
