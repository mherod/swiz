/**
 * Type-safe JSONL parsing utilities.
 *
 * Centralises the split → filter → Bun.JSONL.parse → validate pattern used across
 * transcript readers, hook-log readers, and task audit-log scanners.
 */

import { mkdir, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"
import type { ZodType } from "zod"
import { getLockPathForFile, withFileLock } from "./file-lock.ts"

const NEWLINE_BYTE = 0x0a

type JsonlBuffer = Uint8Array<ArrayBufferLike>
const JSONL_TMP_SUFFIX = ".swiz-jsonl.tmp"
const DEFAULT_JSONL_TAIL_INITIAL_BYTES = 256 * 1024

// ── Streaming / parsed-object reading ────────────────────────────────────────

function concatUint8Arrays(left: JsonlBuffer, right: JsonlBuffer): JsonlBuffer {
  if (left.length === 0) return right
  if (right.length === 0) return left
  const combined = new Uint8Array(left.length + right.length)
  combined.set(left)
  combined.set(right, left.length)
  return combined
}

function findNextLineStart(buffer: JsonlBuffer, start: number): number | null {
  const newlineIndex = buffer.subarray(start).indexOf(NEWLINE_BYTE)
  return newlineIndex === -1 ? null : start + newlineIndex + 1
}

function consumeJsonlChunk(
  buffer: JsonlBuffer,
  onValue: (value: unknown) => void
): { remaining: JsonlBuffer; waitingForMore: boolean } {
  let current = buffer

  while (current.length > 0) {
    const result = Bun.JSONL.parseChunk(current)
    for (const value of result.values) onValue(value)

    if (result.error) {
      const nextLineStart = findNextLineStart(current, result.read)
      if (nextLineStart === null) {
        return { remaining: current, waitingForMore: true }
      }
      current = current.subarray(nextLineStart)
      continue
    }

    if (result.done) return { remaining: new Uint8Array(0), waitingForMore: false }
    if (result.read === 0) return { remaining: current, waitingForMore: true }
    current = current.subarray(result.read)
  }

  return { remaining: current, waitingForMore: false }
}

/**
 * Returns an async iterator that yields parsed JSONL objects from a file.
 * Uses Bun's native JSONL streaming parser. The file is never fully loaded
 * into memory, and malformed lines are silently skipped.
 */
export async function* streamJsonlEntries(path: string): AsyncIterableIterator<unknown> {
  const file = Bun.file(path)
  if (!(await file.exists())) return

  let buffer: JsonlBuffer = new Uint8Array(0)
  const reader = file.stream().getReader()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer = concatUint8Arrays(buffer, value)
    const values: unknown[] = []
    const result = consumeJsonlChunk(buffer, (value) => values.push(value))
    buffer = result.remaining
    for (const value of values) {
      yield value
    }
  }

  if (buffer.length > 0) {
    const values: unknown[] = []
    const result = consumeJsonlChunk(buffer, (value) => values.push(value))
    if (result.waitingForMore && result.remaining.length > 0) {
      const final = Bun.JSONL.parseChunk(result.remaining)
      for (const value of final.values) {
        values.push(value)
      }
    }
    for (const value of values) {
      yield value
    }
  }
}

export async function* streamJsonlLinesFromFile(file: Bun.BunFile): AsyncIterableIterator<string> {
  if (!(await file.exists())) return

  const reader = file.stream().getReader()
  const decoder = new TextDecoder()
  let remaining = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      const { lines, remainder } = splitJsonlChunk(remaining + chunk)
      remaining = remainder
      for (const line of lines) {
        yield line
      }
    }

    const final = remaining + decoder.decode()
    if (final) yield final
  } finally {
    reader.releaseLock()
  }
}

export async function* streamJsonlLines(path: string): AsyncIterableIterator<string> {
  yield* streamJsonlLinesFromFile(Bun.file(path))
}

/**
 * Streaming variant with Zod validation — yields only entries that pass the schema.
 */
export async function* streamJsonlFile<T>(
  path: string,
  schema: ZodType<T>
): AsyncIterableIterator<T> {
  for await (const entry of streamJsonlEntries(path)) {
    const result = schema.safeParse(entry)
    if (result.success) yield result.data
  }
}

// ── Low-level line helpers ───────────────────────────────────────────────────

/** Split a JSONL string into non-empty lines (whitespace-only lines excluded). */
export function splitJsonlLines(text: string): string[] {
  return text.split("\n").filter((l) => l.trim())
}

/**
 * Split streamed JSONL text into complete lines and an unfinished remainder.
 * Preserves blank complete lines so callers can maintain accurate byte offsets.
 */
function splitJsonlChunk(text: string): { lines: string[]; remainder: string } {
  const parts = text.split("\n")
  return {
    lines: parts.slice(0, -1),
    remainder: parts.at(-1) ?? "",
  }
}

/**
 * Parse a single JSON line, returning `undefined` on failure.
 * Uses Bun's native JSONL parser — never throws.
 */
export function tryParseJsonLine(line: string): unknown | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  try {
    return Bun.JSONL.parse(`${trimmed}\n`)[0]
  } catch {
    return undefined
  }
}

// ── Streaming / callback parsing ─────────────────────────────────────────────

/**
 * Iterate over each successfully-parsed JSONL line, invoking `fn` per entry.
 * Avoids allocating an intermediate array — ideal for single-pass accumulation
 * (see transcript-summary.ts accumulator pattern).
 *
 * Malformed JSON lines are silently skipped.
 */
function forEachJsonlLine(text: string, fn: (entry: unknown, index: number) => void): void {
  const lines = splitJsonlLines(text)
  for (let i = 0; i < lines.length; i++) {
    const parsed = tryParseJsonLine(lines[i]!)
    if (parsed !== undefined) fn(parsed, i)
  }
}

/**
 * Like {@link forEachJsonlLine} but validates each entry against a Zod schema.
 * Only invokes `fn` for lines that pass validation.
 */
function forEachJsonlEntry<T>(
  text: string,
  schema: ZodType<T>,
  fn: (entry: T, index: number) => void
): void {
  forEachJsonlLine(text, (parsed, i) => {
    const result = schema.safeParse(parsed)
    if (result.success) fn(result.data, i)
  })
}

// ── Typed collection parsing ─────────────────────────────────────────────────

/**
 * Parse a JSONL string and validate each line against a Zod schema.
 * Malformed JSON and schema-failing lines are silently skipped.
 *
 * @param text     Raw JSONL text (newline-delimited JSON).
 * @param schema   Zod schema to validate each parsed line.
 * @returns        Array of validated entries.
 */
export function parseJsonl<T>(text: string, schema: ZodType<T>): T[] {
  const entries: T[] = []
  forEachJsonlEntry(text, schema, (entry) => entries.push(entry))
  return entries
}

/** Result of parsing a single JSONL line against a Zod schema. */
type JsonlParseResult<T> = { ok: true; data: T; line: number } | { ok: false; line: number }

/**
 * Like {@link parseJsonl} but also yields line indices and error info.
 * Useful when callers need to report which lines failed.
 */
export function parseJsonlDetailed<T>(text: string, schema: ZodType<T>): JsonlParseResult<T>[] {
  const results: JsonlParseResult<T>[] = []
  const lines = splitJsonlLines(text)
  for (let i = 0; i < lines.length; i++) {
    const parsed = tryParseJsonLine(lines[i]!)
    if (parsed === undefined) {
      results.push({ ok: false, line: i })
      continue
    }
    const result = schema.safeParse(parsed)
    if (result.success) {
      results.push({ ok: true, data: result.data, line: i })
    } else {
      results.push({ ok: false, line: i })
    }
  }
  return results
}

// ── Untyped (cast) parsing ───────────────────────────────────────────────────

/**
 * Parse a JSONL string without schema validation — plain JSON.parse per line.
 * Malformed lines are silently skipped.
 *
 * Prefer {@link parseJsonl} with a schema when the shape is known.
 */
export function parseJsonlUntyped(text: string): unknown[] {
  const entries: unknown[] = []
  forEachJsonlLine(text, (entry) => entries.push(entry))
  return entries
}

// ── Head / tail slicing ─────────────────────────────────────────────────────

/**
 * Parse only the first `n` valid lines from a JSONL string against a schema.
 * Stops parsing as soon as `n` entries are collected — avoids processing the
 * full file when only the header matters (e.g. cwd sniffing in task-resolver).
 */
export function parseJsonlHead<T>(text: string, schema: ZodType<T>, n: number): T[] {
  const entries: T[] = []
  for (const line of splitJsonlLines(text)) {
    if (entries.length >= n) break
    const parsed = tryParseJsonLine(line)
    if (parsed === undefined) continue
    const result = schema.safeParse(parsed)
    if (result.success) entries.push(result.data)
  }
  return entries
}

/**
 * Parse the last `n` lines from a JSONL string against a schema.
 * Slices raw lines before parsing — avoids JSON.parse on discarded lines.
 */
function parseJsonlTail<T>(text: string, schema: ZodType<T>, n: number): T[] {
  const lines = splitJsonlLines(text)
  const tail = n >= lines.length ? lines : lines.slice(-n)
  return parseJsonl(tail.join("\n"), schema)
}

/**
 * Parse the last `n` lines from a JSONL string without schema validation.
 * Slices raw lines before parsing — avoids JSON.parse on discarded lines.
 */
function parseJsonlTailUntyped(text: string, n: number): unknown[] {
  const lines = splitJsonlLines(text)
  const tail = n >= lines.length ? lines : lines.slice(-n)
  return parseJsonlUntyped(tail.join("\n"))
}

interface JsonlTailTextMeta {
  reachedStart: boolean
  bytesRead: number
  fileSize: number
}

interface JsonlTailTextResult extends JsonlTailTextMeta {
  text: string
}

interface JsonlTailTextOptions {
  initialBytes?: number
  maxBytes?: number
  isEnough?: (text: string, meta: JsonlTailTextMeta) => boolean
}

function completeJsonlTailText(raw: string, reachedStart: boolean): string {
  if (reachedStart) return raw
  if (raw.charCodeAt(0) === NEWLINE_BYTE) return raw.slice(1)
  const firstNewline = raw.indexOf("\n")
  return firstNewline === -1 ? "" : raw.slice(firstNewline + 1)
}

export async function readJsonlTailTextFromFile(
  file: Bun.BunFile,
  fileSize: number,
  options: JsonlTailTextOptions = {}
): Promise<JsonlTailTextResult> {
  const maxBytes = Math.max(1, Math.min(fileSize + 1, options.maxBytes ?? fileSize + 1))
  const initialBytes = Math.max(1, options.initialBytes ?? DEFAULT_JSONL_TAIL_INITIAL_BYTES)
  let byteLimit = Math.min(maxBytes, initialBytes)

  while (true) {
    const rawStart = Math.max(0, fileSize - byteLimit)
    const readStart = rawStart > 0 ? rawStart - 1 : 0
    const raw = await file.slice(readStart).text()
    const reachedStart = rawStart === 0
    const bytesRead = fileSize - readStart
    const text = completeJsonlTailText(raw, reachedStart)
    const meta = { reachedStart, bytesRead, fileSize }

    const enough = options.isEnough ? options.isEnough(text, meta) : true
    if (enough || reachedStart || byteLimit >= maxBytes) {
      return { ...meta, text }
    }

    const nextByteLimit = Math.min(maxBytes, byteLimit * 2)
    if (nextByteLimit === byteLimit) return { ...meta, text }
    byteLimit = nextByteLimit
  }
}

export async function readJsonlTailText(
  path: string,
  options: JsonlTailTextOptions = {}
): Promise<JsonlTailTextResult | null> {
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) return null
    const stat = await file.stat()
    return await readJsonlTailTextFromFile(file, stat.size, options)
  } catch {
    return null
  }
}

// ── File reading ─────────────────────────────────────────────────────────────

/**
 * Read a JSONL file and validate each line against a Zod schema.
 * Returns `[]` if the file is missing or unreadable.
 */
export async function readJsonlFile<T>(path: string, schema: ZodType<T>): Promise<T[]> {
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) return []
    return parseJsonl(await file.text(), schema)
  } catch {
    return []
  }
}

/**
 * Write an array of entries to a JSONL file with a file-based lock.
 * Overwrites the existing file if it exists.
 */
export async function writeJsonlFile<T>(path: string, entries: T[]): Promise<void> {
  const lockFile = getLockPathForFile(path)
  await withFileLock(lockFile, async () => {
    const text = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : "")
    await writeJsonlTextAtomically(path, text)
  })
}

/**
 * Append a single entry to a JSONL file with a file-based lock.
 */
export async function appendJsonlEntry<T>(path: string, entry: T): Promise<void> {
  const lockFile = getLockPathForFile(path)
  await withFileLock(lockFile, async () => {
    const file = Bun.file(path)
    const existingText = (await file.exists()) ? await file.text() : ""
    const prefix =
      existingText.length > 0 && !existingText.endsWith("\n") ? `${existingText}\n` : existingText
    await writeJsonlTextAtomically(path, `${prefix}${JSON.stringify(entry)}\n`)
  })
}

/**
 * Read a JSONL file without schema validation.
 * Returns `[]` if the file is missing or unreadable.
 */
export async function readJsonlFileUntyped(path: string): Promise<unknown[]> {
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) return []
    return parseJsonlUntyped(await file.text())
  } catch {
    return []
  }
}

function hasAtLeastJsonlLines(count: number): JsonlTailTextOptions["isEnough"] {
  return (text) => splitJsonlLines(text).length >= count
}

/**
 * Read the last `n` validated entries from a JSONL file.
 * Slices raw lines before parsing for efficiency on large log files.
 */
export async function readJsonlFileTail<T>(
  path: string,
  schema: ZodType<T>,
  n: number
): Promise<T[]> {
  const result = await readJsonlTailText(path, { isEnough: hasAtLeastJsonlLines(n) })
  return result ? parseJsonlTail(result.text, schema, n) : []
}

export async function readJsonlFileTailUntyped(path: string, n: number): Promise<unknown[]> {
  const result = await readJsonlTailText(path, { isEnough: hasAtLeastJsonlLines(n) })
  return result ? parseJsonlTailUntyped(result.text, n) : []
}

function buildJsonlTempPath(path: string): string {
  return `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}${JSONL_TMP_SUFFIX}`
}

async function writeJsonlTextAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = buildJsonlTempPath(path)
  await Bun.write(tempPath, text)
  try {
    await rename(tempPath, path)
  } catch (error) {
    try {
      await rm(tempPath, { force: true })
    } catch {
      // Best-effort cleanup only.
    }
    throw error
  }
}
