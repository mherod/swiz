/**
 * Dispatch stdin payloads are written to `/tmp/swiz-incoming/` **by default** for inspection.
 * Every dispatch writes a `*.raw.json` companion file containing the exact stdin
 * bytes before JSON parsing, normalization, sanitization, or enrichment.
 *
 * **Disable** with **`SWIZ_CAPTURE_INCOMING=0`** or **`SWIZ_CAPTURE_INCOMING_PAYLOADS=0`** (also
 * `false`, `no`, `off`). Throttled daemon maintenance enforces configurable age
 * and byte limits across capture pairs and event JSONL files.
 *
 * Filename pattern: `{YYYY-MM-DD}T{HH-mm-ss-sss}-{canonicalEventName}-{id}.json` with `incoming` (before
 * `normalizeAgentHookPayload`) and `afterNormalizeAndBackfill`; raw companion:
 * `{YYYY-MM-DD}T{HH-mm-ss-sss}-{canonicalEventName}-{id}.raw.json`.
 *
 * **JSONL files**: Each dispatch also appends a sanitized raw payload line to
 * `/tmp/swiz-incoming/{canonicalEventName}.jsonl` for easy streaming inspection.
 *
 * **Event name normalization:** Filenames use canonical camelCase event names for consistency across agents:
 * - Agent-specific names (PreToolUse, PostToolUse, beforeShellExecution, etc.) are normalized
 * - Maps to canonical names (preToolUse, postToolUse, sessionStart, etc.)
 *
 * **Secrets:** `_env` (injected by `swiz dispatch` for hook subprocesses) is **never** written —
 * it is replaced with `_envKeys` (sorted var names only). `user_email` is redacted.
 */

import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises"
import { join } from "node:path"
import { debugLog } from "../debug.ts"
import { SWIZ_INCOMING_ROOT } from "../temp-paths.ts"
import { messageFromUnknownError } from "../utils/hook-json-helpers.ts"

/** Age threshold for deleting prior capture files (10 minutes). */
export const SWIZ_INCOMING_RETENTION_MS = 10 * 60 * 1000

/** Total capture-directory budget (64 MiB). */
export const SWIZ_INCOMING_MAX_BYTES = 64 * 1024 * 1024

/** Per-event JSONL segment budget (4 MiB). */
export const SWIZ_INCOMING_JSONL_MAX_BYTES = 4 * 1024 * 1024

/** Minimum interval between incoming-capture directory scans. */
export const SWIZ_INCOMING_PRUNE_INTERVAL_MS = 60 * 1000

interface IncomingCapturePruneState {
  inFlight: boolean
  lastStartedAt: number
}

const incomingCapturePruneStateByDir = new Map<string, IncomingCapturePruneState>()
const jsonlAppendQueueByPath = new Map<string, Promise<void>>()
const activeCapturePaths = new Set<string>()

export interface IncomingCaptureLimits {
  maxAgeMs: number
  maxBytes: number
  jsonlMaxBytes: number
}

function positiveEnvNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Resolve capture limits at operation time so daemon env changes apply after restart. */
export function resolveIncomingCaptureLimits(
  env: Record<string, string | undefined> = process.env
): IncomingCaptureLimits {
  return {
    maxAgeMs: positiveEnvNumber(env.SWIZ_INCOMING_RETENTION_MS, SWIZ_INCOMING_RETENTION_MS),
    maxBytes: positiveEnvNumber(env.SWIZ_INCOMING_MAX_BYTES, SWIZ_INCOMING_MAX_BYTES),
    jsonlMaxBytes: positiveEnvNumber(
      env.SWIZ_INCOMING_JSONL_MAX_BYTES,
      SWIZ_INCOMING_JSONL_MAX_BYTES
    ),
  }
}

function isExplicitlyDisabled(v: string | undefined): boolean {
  if (v === undefined) return false
  if (v === "") return true
  return ["0", "false", "no", "off"].includes(v.toLowerCase())
}

/** Capture is on unless either env var explicitly disables it. */
export function shouldCaptureIncomingPayloads(): boolean {
  if (isExplicitlyDisabled(process.env.SWIZ_CAPTURE_INCOMING)) return false
  if (isExplicitlyDisabled(process.env.SWIZ_CAPTURE_INCOMING_PAYLOADS)) return false
  return true
}

/** Safe single path segment for filenames. */
export function sanitizeHookFilenameSegment(name: string): string {
  const s = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "hook"
  return s.slice(0, 120)
}

/**
 * Normalize agent-specific event names to canonical camelCase form.
 * Handles PascalCase (Claude Code in Cursor), agent aliases (beforeShellExecution),
 * and already-canonical names.
 */
export function normalizeEventNameToCanonical(eventName: string): string {
  // Agent alias mappings (Cursor CLI)
  const aliasMap: Record<string, string> = {
    beforeShellExecution: "preToolUse",
    afterShellExecution: "postToolUse",
  }

  // Check direct alias first
  const aliased = aliasMap[eventName]
  if (aliased) return aliased

  // Convert PascalCase to camelCase (PreToolUse → preToolUse)
  if (eventName.length > 0) {
    const first = eventName[0]
    if (first && first === first.toUpperCase() && first !== first.toLowerCase()) {
      return first.toLowerCase() + eventName.slice(1)
    }
  }

  // Already canonical or unknown; return as-is
  return eventName
}

/**
 * Strip high-risk fields from dispatch payloads before writing to disk. The CLI injects full
 * `process.env` as `_env` — that must not be persisted in `/tmp`.
 */
export function sanitizeDispatchPayloadForCapture(o: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const key of Object.keys(o)) {
    if (key === "_env") continue
    out[key] = o[key]
  }
  if (o._env && typeof o._env === "object" && !Array.isArray(o._env)) {
    out._envKeys = Object.keys(o._env as Record<string, any>).sort()
  }
  if (typeof out.user_email === "string" && out.user_email.includes("@")) {
    out.user_email = "[redacted]"
  }
  return out
}

export function buildIncomingCaptureFilename(hookEventName: string): string {
  const iso = new Date().toISOString()
  const datePart = iso.slice(0, 10)
  const timePart = iso.slice(11, 23).replace(/:/g, "-")
  const canonical = normalizeEventNameToCanonical(hookEventName)
  const safe = sanitizeHookFilenameSegment(canonical)
  const id = randomUUID().slice(0, 8)
  return `${datePart}T${timePart}-${safe}-${id}.json`
}

export function buildRawIncomingCaptureFilename(captureFilename: string): string {
  return captureFilename.replace(/\.json$/, ".raw.json")
}

interface CaptureFileInfo {
  name: string
  path: string
  size: number
  mtimeMs: number
}

interface CaptureFileGroup {
  files: CaptureFileInfo[]
  inFlight: boolean
  mtimeMs: number
  size: number
}

function isCaptureFilename(name: string): boolean {
  return name.endsWith(".json") || name.endsWith(".jsonl")
}

function captureGroupKey(name: string): string {
  if (name.endsWith(".raw.json")) return name.slice(0, -".raw.json".length)
  if (name.endsWith(".json")) return name.slice(0, -".json".length)
  return name
}

function groupCaptureFiles(files: CaptureFileInfo[]): CaptureFileGroup[] {
  const groups = new Map<string, CaptureFileInfo[]>()
  for (const file of files) {
    const key = captureGroupKey(file.name)
    const group = groups.get(key) ?? []
    group.push(file)
    groups.set(key, group)
  }
  return [...groups.values()].map((groupFiles) => ({
    files: groupFiles,
    inFlight: groupFiles.some(
      (file) => activeCapturePaths.has(file.path) || jsonlAppendQueueByPath.has(file.path)
    ),
    mtimeMs: Math.max(...groupFiles.map((file) => file.mtimeMs)),
    size: groupFiles.reduce((total, file) => total + file.size, 0),
  }))
}

async function removeCaptureGroup(group: CaptureFileGroup): Promise<void> {
  await Promise.all(
    group.files.map(async (file) => {
      try {
        await unlink(file.path)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
      }
    })
  )
}

async function readCaptureFileInfo(
  dir: string,
  entry: { isFile(): boolean; name: string }
): Promise<CaptureFileInfo | null> {
  if (!entry.isFile() || !isCaptureFilename(entry.name)) return null
  const path = join(dir, entry.name)
  try {
    const metadata = await stat(path)
    return { name: entry.name, path, size: metadata.size, mtimeMs: metadata.mtimeMs }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
    debugLog("[incoming-capture] prune stat failed:", path, messageFromUnknownError(e))
    return null
  }
}

async function enforceCaptureLimits(
  groups: CaptureFileGroup[],
  now: number,
  maxAgeMs: number,
  maxBytes: number
): Promise<void> {
  const retained: CaptureFileGroup[] = []
  let retainedBytes = 0
  for (const group of groups) {
    if (!group.inFlight && now - group.mtimeMs > maxAgeMs) {
      await removeCaptureGroup(group)
      continue
    }
    retained.push(group)
    retainedBytes += group.size
  }

  retained.sort((a, b) => a.mtimeMs - b.mtimeMs)
  for (const group of retained) {
    if (retainedBytes <= maxBytes) break
    if (group.inFlight) continue
    try {
      await removeCaptureGroup(group)
      retainedBytes -= group.size
    } catch (e) {
      debugLog("[incoming-capture] prune group failed:", messageFromUnknownError(e))
    }
  }
}

/** Enforce age and total-byte budgets for capture pairs and JSONL segments. */
export async function pruneStaleIncomingCaptures(
  dir: string = SWIZ_INCOMING_ROOT,
  maxAgeMs: number = resolveIncomingCaptureLimits().maxAgeMs,
  maxBytes: number = resolveIncomingCaptureLimits().maxBytes
): Promise<void> {
  const now = Date.now()
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const files = await Promise.all(entries.map((entry) => readCaptureFileInfo(dir, entry)))
    const groups = groupCaptureFiles(files.filter((file): file is CaptureFileInfo => file !== null))
    await enforceCaptureLimits(groups, now, maxAgeMs, maxBytes)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ENOENT") return
    debugLog("[incoming-capture] prune readdir failed:", messageFromUnknownError(e))
  }
}

/**
 * Schedule stale-capture maintenance without putting the directory scan on the dispatch path.
 * Concurrent requests share the in-flight scan and subsequent requests are throttled per directory.
 */
export function scheduleStaleIncomingCapturePrune(
  dir: string = SWIZ_INCOMING_ROOT,
  maxAgeMs: number = resolveIncomingCaptureLimits().maxAgeMs,
  now: number = Date.now(),
  maxBytes: number = resolveIncomingCaptureLimits().maxBytes
): boolean {
  const current = incomingCapturePruneStateByDir.get(dir)
  const elapsedMs = current ? now - current.lastStartedAt : Number.POSITIVE_INFINITY
  if (current?.inFlight || (elapsedMs >= 0 && elapsedMs < SWIZ_INCOMING_PRUNE_INTERVAL_MS)) {
    return false
  }

  const state: IncomingCapturePruneState = { inFlight: true, lastStartedAt: now }
  incomingCapturePruneStateByDir.set(dir, state)
  void Promise.resolve()
    .then(() => pruneStaleIncomingCaptures(dir, maxAgeMs, maxBytes))
    .catch((err) => {
      debugLog("[incoming-capture] scheduled prune failed:", messageFromUnknownError(err))
    })
    .finally(() => {
      if (incomingCapturePruneStateByDir.get(dir) === state) state.inFlight = false
    })
  return true
}

interface IncomingDispatchCaptureArgs {
  canonicalEvent: string
  hookEventName: string
  parseError: boolean
  payloadStr: string
  /** Clone of payload before `normalizeAgentHookPayload`; null when `parseError`. */
  incomingBeforeNormalize: Record<string, any> | null
  /** Clone of payload after normalize + backfill. */
  normalizedPayload: Record<string, any>
}

/** Caller should invoke only when `shouldCaptureIncomingPayloads()` is true. */
export function scheduleIncomingDispatchCapture(
  args: IncomingDispatchCaptureArgs,
  dir: string = SWIZ_INCOMING_ROOT
): void {
  void writeIncomingDispatchCapture(args, dir).catch((err) => {
    debugLog("[incoming-capture] failed:", messageFromUnknownError(err))
  })
}

export function buildIncomingDispatchCaptureEnvelope(
  args: IncomingDispatchCaptureArgs
): Record<string, any> {
  const envelope: Record<string, any> = {
    _swizIncomingCapture: {
      canonicalEvent: args.canonicalEvent,
      hookEventName: args.hookEventName,
      capturedAt: new Date().toISOString(),
      parseError: args.parseError,
      rawPayloadFile: "",
    },
  }

  if (args.parseError) {
    envelope.rawPayload = args.payloadStr
  } else {
    if (args.incomingBeforeNormalize) {
      envelope.incoming = sanitizeDispatchPayloadForCapture(args.incomingBeforeNormalize)
    }
    envelope.afterNormalizeAndBackfill = sanitizeDispatchPayloadForCapture(args.normalizedPayload)
  }

  return envelope
}

/**
 * Append a sanitized raw payload as one JSON line to `/tmp/swiz-incoming/{canonicalEventName}.jsonl`.
 * Caller should check `shouldCaptureIncomingPayloads()` before calling.
 */
export async function appendPayloadToJsonl(
  hookEventName: string,
  payload: Record<string, any>,
  dir: string = SWIZ_INCOMING_ROOT,
  maxBytes: number = resolveIncomingCaptureLimits().jsonlMaxBytes
): Promise<void> {
  const canonical = normalizeEventNameToCanonical(hookEventName)
  const safe = sanitizeHookFilenameSegment(canonical)
  const path = join(dir, `${safe}.jsonl`)
  const sanitized = sanitizeDispatchPayloadForCapture(payload)
  const line = `${JSON.stringify({ ...sanitized, _capturedAt: new Date().toISOString() })}\n`
  const lineBytes = new TextEncoder().encode(line).byteLength
  const previous = jsonlAppendQueueByPath.get(path) ?? Promise.resolve()
  const operation = previous
    .catch(() => {})
    .then(async () => {
      await mkdir(dir, { recursive: true })
      try {
        const metadata = await stat(path)
        if (metadata.size > 0 && metadata.size + lineBytes > maxBytes) {
          const rotatedPath = join(
            dir,
            `${safe}.${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.jsonl`
          )
          await rename(path, rotatedPath)
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
      }
      await appendFile(path, line)
    })
  jsonlAppendQueueByPath.set(path, operation)
  try {
    await operation
  } finally {
    if (jsonlAppendQueueByPath.get(path) === operation) jsonlAppendQueueByPath.delete(path)
  }
}

/** Fire-and-forget wrapper for `appendPayloadToJsonl`. */
export function schedulePayloadJsonlAppend(
  hookEventName: string,
  payload: Record<string, any>
): void {
  void appendPayloadToJsonl(hookEventName, payload).catch((err) => {
    debugLog("[incoming-capture] jsonl append failed:", messageFromUnknownError(err))
  })
}

export async function writeIncomingDispatchCapture(
  args: IncomingDispatchCaptureArgs,
  dir: string = SWIZ_INCOMING_ROOT
): Promise<void> {
  await mkdir(dir, { recursive: true })
  const filename = buildIncomingCaptureFilename(args.hookEventName)
  const rawFilename = buildRawIncomingCaptureFilename(filename)
  const path = join(dir, filename)
  const rawPath = join(dir, rawFilename)
  const envelope = buildIncomingDispatchCaptureEnvelope(args)
  envelope._swizIncomingCapture.rawPayloadFile = rawFilename
  activeCapturePaths.add(rawPath)
  activeCapturePaths.add(path)
  try {
    await Promise.all([
      Bun.write(rawPath, args.payloadStr),
      Bun.write(path, `${JSON.stringify(envelope, null, 2)}\n`),
    ])
  } finally {
    activeCapturePaths.delete(rawPath)
    activeCapturePaths.delete(path)
  }
}
