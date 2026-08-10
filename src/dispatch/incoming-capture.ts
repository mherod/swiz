/**
 * Dispatch stdin payloads are written to `/tmp/swiz-incoming/` **by default** for inspection.
 * Sanitized captures are enabled by default. Exact stdin bytes are written only
 * when `SWIZ_CAPTURE_INCOMING_RAW=1` is explicitly enabled.
 *
 * **Disable** with **`SWIZ_CAPTURE_INCOMING=0`** or **`SWIZ_CAPTURE_INCOMING_PAYLOADS=0`** (also
 * `false`, `no`, `off`). Throttled daemon maintenance enforces configurable age
 * and byte limits across capture pairs and event JSONL files.
 *
 * Filename pattern: `{YYYY-MM-DD}T{HH-mm-ss-sss}-{canonicalEventName}-{id}.json` with sanitized
 * `incoming` and a `normalizationDelta`. Optional raw companion:
 * `{YYYY-MM-DD}T{HH-mm-ss-sss}-{canonicalEventName}-{id}.raw.json`.
 *
 * **JSONL files**: Each dispatch also appends a content-free shape/identity summary to
 * `/tmp/swiz-incoming/{canonicalEventName}.jsonl` for streaming analysis.
 *
 * **Event name normalization:** Filenames use canonical camelCase event names for consistency across agents:
 * - Agent-specific names (PreToolUse, PostToolUse, beforeShellExecution, etc.) are normalized
 * - Maps to canonical names (preToolUse, postToolUse, sessionStart, etc.)
 *
 * **Secrets:** sanitization is recursive. `_env` becomes `_envKeys`; credential-like keys,
 * user email, and high-confidence token strings are redacted. Captures are stored with 0700/0600 modes.
 */

import { createHash, randomUUID } from "node:crypto"
import { appendFile, chmod, lstat, mkdir, readdir, rename, stat, unlink } from "node:fs/promises"
import { join } from "node:path"
import { debugLog } from "../debug.ts"
import { SWIZ_INCOMING_ROOT } from "../temp-paths.ts"
import { messageFromUnknownError } from "../utils/hook-json-helpers.ts"
import { writeJsonlTextAtomically } from "../utils/jsonl.ts"
import { dispatchToolUseId } from "./dispatch-id.ts"

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
const CAPTURE_DIRECTORY_MODE = 0o700
const CAPTURE_FILE_MODE = 0o600
const MAX_CAPTURE_STRING_LENGTH = 64 * 1024
const SENSITIVE_KEY_RE =
  /authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret/i
const BEARER_SECRET_RE = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi
const TOKEN_SECRET_RE = /\b(?:github_pat_|gh[pousr]_|sk-(?:proj-)?)[A-Za-z0-9_-]{12,}\b/g
const AWS_ACCESS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g

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
export function shouldCaptureIncomingPayloads(
  env: Record<string, string | undefined> = process.env
): boolean {
  if (isExplicitlyDisabled(env.SWIZ_CAPTURE_INCOMING)) return false
  if (isExplicitlyDisabled(env.SWIZ_CAPTURE_INCOMING_PAYLOADS)) return false
  return true
}

/** Exact wire payloads are disabled unless explicitly enabled. */
export function shouldCaptureRawIncomingPayloads(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.SWIZ_CAPTURE_INCOMING_RAW === "1"
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
  return sanitizeCaptureObject(o, new WeakSet<object>(), 0)
}

function sanitizeCaptureString(value: string): string {
  const redacted = value
    .replace(BEARER_SECRET_RE, "Bearer [redacted]")
    .replace(TOKEN_SECRET_RE, "[redacted]")
    .replace(AWS_ACCESS_KEY_RE, "[redacted]")
  if (redacted.length <= MAX_CAPTURE_STRING_LENGTH) return redacted
  return `${redacted.slice(0, MAX_CAPTURE_STRING_LENGTH)}…[truncated ${redacted.length - MAX_CAPTURE_STRING_LENGTH} chars]`
}

function sanitizeCaptureValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "string") return sanitizeCaptureString(value)
  if (value === null || typeof value !== "object") return value
  if (depth >= 12) return "[truncated: max depth]"
  if (seen.has(value)) return "[redacted: circular]"
  seen.add(value)
  if (Array.isArray(value)) {
    const sanitized = value.map((item) => sanitizeCaptureValue(item, seen, depth + 1))
    seen.delete(value)
    return sanitized
  }
  const sanitized = sanitizeCaptureObject(value as Record<string, unknown>, seen, depth + 1)
  seen.delete(value)
  return sanitized
}

function sanitizeCaptureObject(
  value: Record<string, unknown>,
  seen: WeakSet<object>,
  depth: number
): Record<string, any> {
  const out: Record<string, any> = {}
  const envValue = value._env
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === "_env") continue
    if (key === "user_email" || SENSITIVE_KEY_RE.test(key)) {
      out[key] = "[redacted]"
      continue
    }
    out[key] = sanitizeCaptureValue(nestedValue, seen, depth)
  }
  if (envValue && typeof envValue === "object" && !Array.isArray(envValue)) {
    out._envKeys = Object.keys(envValue).sort()
  }
  return out
}

async function ensureIncomingCaptureDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: CAPTURE_DIRECTORY_MODE })
  const metadata = await lstat(dir)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Incoming capture path is not a secure directory: ${dir}`)
  }
  const currentUid = process.getuid?.()
  if (currentUid !== undefined && metadata.uid !== currentUid) {
    throw new Error(`Incoming capture directory is owned by another user: ${dir}`)
  }
  if ((metadata.mode & 0o777) !== CAPTURE_DIRECTORY_MODE) {
    await chmod(dir, CAPTURE_DIRECTORY_MODE)
  }
}

async function secureCaptureFile(path: string): Promise<void> {
  await chmod(path, CAPTURE_FILE_MODE)
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

function enqueueJsonlOperation(path: string, run: () => Promise<void>): Promise<void> {
  const previous = jsonlAppendQueueByPath.get(path) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(run)
  jsonlAppendQueueByPath.set(path, operation)
  return operation.finally(() => {
    if (jsonlAppendQueueByPath.get(path) === operation) jsonlAppendQueueByPath.delete(path)
  })
}

async function compactIncomingJsonlByRecordAge(path: string, cutoffMs: number): Promise<void> {
  const file = Bun.file(path)
  if (!(await file.exists())) return
  const original = await file.text()
  let removed = false
  const retained: string[] = []
  for (const line of original.split("\n")) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as Record<string, unknown>
      const capturedAt =
        typeof record._capturedAt === "string" ? Date.parse(record._capturedAt) : NaN
      if (Number.isFinite(capturedAt) && capturedAt < cutoffMs) {
        removed = true
        continue
      }
    } catch {
      // Preserve malformed legacy lines; file-age pruning remains their fallback.
    }
    retained.push(line)
  }
  if (!removed) return
  if (retained.length === 0) {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
    return
  }
  await writeJsonlTextAtomically(path, `${retained.join("\n")}\n`)
  await secureCaptureFile(path)
}

/** Enforce age and total-byte budgets for capture pairs and JSONL segments. */
export async function pruneStaleIncomingCaptures(
  dir: string = SWIZ_INCOMING_ROOT,
  maxAgeMs: number = resolveIncomingCaptureLimits().maxAgeMs,
  maxBytes: number = resolveIncomingCaptureLimits().maxBytes
): Promise<void> {
  const now = Date.now()
  try {
    const initialEntries = await readdir(dir, { withFileTypes: true })
    await Promise.all(
      initialEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => {
          const path = join(dir, entry.name)
          return enqueueJsonlOperation(path, () =>
            compactIncomingJsonlByRecordAge(path, now - maxAgeMs)
          )
        })
    )
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
  const payloadBytes = new TextEncoder().encode(args.payloadStr).byteLength
  const dispatchId =
    args.normalizedPayload._swizDispatchId ?? args.incomingBeforeNormalize?._swizDispatchId
  const toolUseId = dispatchToolUseId(args.normalizedPayload)
  const envelope: Record<string, any> = {
    _swizIncomingCapture: {
      formatVersion: 2,
      canonicalEvent: args.canonicalEvent,
      hookEventName: args.hookEventName,
      capturedAt: new Date().toISOString(),
      parseError: args.parseError,
      payloadBytes,
      payloadSha256: createHash("sha256").update(args.payloadStr).digest("hex"),
      ...(typeof dispatchId === "string" ? { dispatchId } : {}),
      ...(toolUseId ? { toolUseId } : {}),
    },
  }

  if (!args.parseError && args.incomingBeforeNormalize) {
    const incoming = sanitizeDispatchPayloadForCapture(args.incomingBeforeNormalize)
    const normalized = sanitizeDispatchPayloadForCapture(args.normalizedPayload)
    envelope.incoming = incoming
    envelope.normalizationDelta = buildNormalizationDelta(incoming, normalized)
  }

  return envelope
}

function buildNormalizationDelta(
  incoming: Record<string, any>,
  normalized: Record<string, any>
): { set: Record<string, any>; removed: string[] } {
  const set: Record<string, any> = {}
  const removed: string[] = []
  for (const [key, value] of Object.entries(normalized)) {
    if (!(key in incoming) || JSON.stringify(incoming[key]) !== JSON.stringify(value))
      set[key] = value
  }
  for (const key of Object.keys(incoming)) {
    if (!(key in normalized)) removed.push(key)
  }
  return { set, removed }
}

/**
 * Append a content-free payload summary to `/tmp/swiz-incoming/{canonicalEventName}.jsonl`.
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
  const line = `${JSON.stringify(summarizeDispatchPayloadForJsonl(payload))}\n`
  const lineBytes = new TextEncoder().encode(line).byteLength
  await enqueueJsonlOperation(path, async () => {
    await ensureIncomingCaptureDirectory(dir)
    try {
      const metadata = await stat(path)
      if (metadata.size > 0 && metadata.size + lineBytes > maxBytes) {
        const rotatedPath = join(
          dir,
          `${safe}.${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.jsonl`
        )
        await rename(path, rotatedPath)
        await secureCaptureFile(rotatedPath)
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
    }
    await appendFile(path, line, { mode: CAPTURE_FILE_MODE })
    await secureCaptureFile(path)
  })
}

export function summarizeDispatchPayloadForJsonl(
  payload: Record<string, any>
): Record<string, any> {
  const sanitized = sanitizeDispatchPayloadForCapture(payload)
  const toolInput = sanitized.tool_input
  const summaryKeys = [
    "session_id",
    "cwd",
    "tool_name",
    "tool_use_id",
    "tool_call_id",
    "request_id",
    "_swizDispatchId",
    "_agent",
    "trigger",
  ] as const
  const summary: Record<string, any> = {
    _capturedAt: new Date().toISOString(),
    _topLevelKeys: Object.keys(sanitized).sort(),
  }
  for (const key of summaryKeys) {
    if (sanitized[key] !== undefined) summary[key] = sanitized[key]
  }
  if (Array.isArray(sanitized._envKeys)) summary._envKeys = sanitized._envKeys
  if (toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)) {
    summary._toolInputKeys = Object.keys(toolInput).sort()
    summary._toolInputBytes = new TextEncoder().encode(JSON.stringify(toolInput)).byteLength
  }
  return summary
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
  dir: string = SWIZ_INCOMING_ROOT,
  captureRaw: boolean = shouldCaptureRawIncomingPayloads()
): Promise<void> {
  await ensureIncomingCaptureDirectory(dir)
  const filename = buildIncomingCaptureFilename(args.hookEventName)
  const path = join(dir, filename)
  const envelope = buildIncomingDispatchCaptureEnvelope(args)
  activeCapturePaths.add(path)
  let rawPath: string | null = null
  if (captureRaw) {
    const rawFilename = buildRawIncomingCaptureFilename(filename)
    rawPath = join(dir, rawFilename)
    envelope._swizIncomingCapture.rawPayloadFile = rawFilename
    activeCapturePaths.add(rawPath)
  }
  try {
    const writes: Promise<unknown>[] = [
      Bun.write(path, `${JSON.stringify(envelope, null, 2)}\n`).then(() => secureCaptureFile(path)),
    ]
    if (rawPath) {
      writes.push(Bun.write(rawPath, args.payloadStr).then(() => secureCaptureFile(rawPath!)))
    }
    await Promise.all(writes)
  } finally {
    if (rawPath) activeCapturePaths.delete(rawPath)
    activeCapturePaths.delete(path)
  }
}
