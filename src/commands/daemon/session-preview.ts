import type { Session } from "../../transcript-utils.ts"
import { readJsonlTailTextFromFile } from "../../utils/jsonl.ts"

/** Bound disk reads before parsing; a message-count cap cannot bound allocations. */
export const MAX_SESSION_PREVIEW_BYTES = 8 * 1024 * 1024
export const MAX_SESSION_CACHE_BYTES = 32 * 1024 * 1024

const JSONL_FORMATS = new Set<Session["format"]>([
  "jsonl",
  "codex-jsonl",
  "cursor-agent-jsonl",
  "antigravity-jsonl",
])

/** Dashboard history is a recent preview. Never truncate a JSON document or SQLite file. */
export async function readSessionPreview(
  file: Bun.BunFile,
  size: number,
  format?: Session["format"]
): Promise<string | null> {
  if (size <= MAX_SESSION_PREVIEW_BYTES) return file.slice(0, size).text()
  const isJsonl = format ? JSONL_FORMATS.has(format) : file.name?.endsWith(".jsonl")
  if (!isJsonl) return null
  const result = await readJsonlTailTextFromFile(file, size, {
    initialBytes: MAX_SESSION_PREVIEW_BYTES,
    maxBytes: MAX_SESSION_PREVIEW_BYTES,
  })
  return result.text
}
