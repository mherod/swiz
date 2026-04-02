/**
 * Type-safe JSONL parsing utilities.
 *
 * Centralises the split → filter → JSON.parse → validate pattern used across
 * transcript readers, hook-log readers, and task audit-log scanners.
 *
 * Backed by `stream-json/jsonl/parser` for both streaming file reads and
 * single-line parsing via its `checkedParse` helper.
 */

import { createReadStream } from "node:fs"
import jsonlParser from "stream-json/jsonl/parser.js"
import type { ZodType } from "zod"

const { checkedParse } = jsonlParser

// ── Streaming / parsed-object reading ────────────────────────────────────────

/**
 * Returns an async iterator that yields parsed JSONL objects from a file.
 * Uses `stream-json/jsonl/parser` for efficient streaming — the file is never
 * fully loaded into memory.  Malformed lines are silently skipped.
 */
export async function* streamJsonlEntries(path: string): AsyncIterableIterator<unknown> {
  const file = Bun.file(path)
  if (!(await file.exists())) return

  const pipeline = createReadStream(path).pipe(jsonlParser.asStream({ errorIndicator: undefined }))

  for await (const { value } of pipeline as AsyncIterable<jsonlParser.JsonlItem>) {
    yield value
  }
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
 * Parse a single JSON line, returning `undefined` on failure.
 * Delegates to `stream-json`'s `checkedParse` — never throws.
 */
export function tryParseJsonLine(line: string): unknown | undefined {
  return checkedParse(line, undefined, undefined)
}

// ── Streaming / callback parsing ─────────────────────────────────────────────

/**
 * Iterate over each successfully-parsed JSONL line, invoking `fn` per entry.
 * Avoids allocating an intermediate array — ideal for single-pass accumulation
 * (see transcript-summary.ts accumulator pattern).
 *
 * Malformed JSON lines are silently skipped.
 */
export function forEachJsonlLine(text: string, fn: (entry: unknown, index: number) => void): void {
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
export function forEachJsonlEntry<T>(
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
export type JsonlParseResult<T> = { ok: true; data: T; line: number } | { ok: false; line: number }

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
export function parseJsonlTail<T>(text: string, schema: ZodType<T>, n: number): T[] {
  const lines = splitJsonlLines(text)
  const tail = n >= lines.length ? lines : lines.slice(-n)
  return parseJsonl(tail.join("\n"), schema)
}

/**
 * Parse the last `n` lines from a JSONL string without schema validation.
 * Slices raw lines before parsing — avoids JSON.parse on discarded lines.
 */
export function parseJsonlTailUntyped(text: string, n: number): unknown[] {
  const lines = splitJsonlLines(text)
  const tail = n >= lines.length ? lines : lines.slice(-n)
  return parseJsonlUntyped(tail.join("\n"))
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

/**
 * Read the last `n` validated entries from a JSONL file.
 * Slices raw lines before parsing for efficiency on large log files.
 */
export async function readJsonlFileTail<T>(
  path: string,
  schema: ZodType<T>,
  n: number
): Promise<T[]> {
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) return []
    return parseJsonlTail(await file.text(), schema, n)
  } catch {
    return []
  }
}
