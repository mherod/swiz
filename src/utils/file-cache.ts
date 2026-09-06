import { stat } from "node:fs/promises"
import { LRUCache } from "lru-cache"

/**
 * In-memory cache for file contents, to avoid repeated reads of stable files
 * (those not modified in the last 2 hours).
 *
 * Bounded on three axes because an unbounded `Map` here meant ordinary dashboard
 * polling retained every transcript and Cursor database it had ever discovered —
 * unbounded retention of local data that is often sensitive (#814). Entry count
 * caps pathological file counts, total bytes cap aggregate residency, and the
 * per-entry admission ceiling stops one large file from evicting everything else.
 */
const MAX_CACHE_ENTRIES = 256
const MAX_CACHE_BYTES = 16 * 1024 * 1024
/** Above this, a read still serves its caller but is never retained. */
const MAX_ENTRY_BYTES = 2 * 1024 * 1024
const TWO_HOURS_MS = 2 * 60 * 60 * 1000

/**
 * Identity of the bytes a cache entry was built from.
 *
 * mtime alone is not enough: a replaced file can land with a preserved timestamp,
 * and same-size replacement is exactly the case that looks like a hit. Inode is
 * included when the platform reports it, and its absence is itself part of the
 * fingerprint, so identity that appears or disappears counts as a change.
 */
interface CachedFile {
  content: string
  mtime: number
  size: number
  ino?: number
  bytes: number
}

const FILE_CACHE = new LRUCache<string, CachedFile>({
  max: MAX_CACHE_ENTRIES,
  maxSize: MAX_CACHE_BYTES,
  // lru-cache rejects a zero size, and an empty file still occupies an entry slot.
  sizeCalculation: (entry) => Math.max(1, entry.bytes),
})

/** Aggregate UTF-8 bytes of cached content. Never serializes content or paths. */
export function getFileCacheMemoryStats(): { entries: number; estimatedBytes: number } {
  return { entries: FILE_CACHE.size, estimatedBytes: FILE_CACHE.calculatedSize ?? 0 }
}

function fingerprintMatches(
  cached: CachedFile,
  s: { mtimeMs: number; size: number; ino?: number }
) {
  return cached.mtime === s.mtimeMs && cached.size === s.size && cached.ino === s.ino
}

function inodeOf(s: { ino?: number }): number | undefined {
  return typeof s.ino === "number" && Number.isFinite(s.ino) ? s.ino : undefined
}

/** Store only when the payload fits the admission ceiling; oversized reads pass through. */
function admit(key: string, content: string, s: { mtimeMs: number; size: number; ino?: number }) {
  const bytes = Buffer.byteLength(content, "utf8")
  if (bytes > MAX_ENTRY_BYTES) {
    // A previously admitted smaller version must not be served for these bytes.
    FILE_CACHE.delete(key)
    return
  }
  FILE_CACHE.set(key, { content, mtime: s.mtimeMs, size: s.size, ino: s.ino, bytes })
}

/**
 * Reads a file's content, caching "stable" files (older than 2 hours).
 *
 * A cached entry is returned only when the file is stable and its fingerprint still
 * matches; otherwise the file is re-read.
 */
export async function getCachedFileText(path: string): Promise<string> {
  try {
    const s = await stat(path)
    const identity = { mtimeMs: s.mtimeMs, size: s.size, ino: inodeOf(s) }
    const now = Date.now()

    const cached = FILE_CACHE.get(path)
    if (cached && now - s.mtimeMs > TWO_HOURS_MS && fingerprintMatches(cached, identity)) {
      return cached.content
    }

    const content = await Bun.file(path).text()
    admit(path, content, identity)
    return content
  } catch {
    return ""
  }
}

/**
 * Specialized version for reading JSON.
 */
export async function getCachedFileJson(path: string): Promise<any> {
  const text = await getCachedFileText(path)
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/**
 * Reads the first N lines of a file using a bounded disk read.
 * Only reads up to {@link LINES_PREFIX_BYTES} bytes — enough for typical
 * JSONL headers — instead of loading the entire file into memory.
 */
export async function getCachedLines(path: string, count: number): Promise<string[]> {
  // 50 JSONL lines of ~2KB each ≈ 100KB is generous for header scanning.
  const prefix = await getCachedPrefix(path, LINES_PREFIX_BYTES)
  if (!prefix) return []
  return prefix.split("\n").slice(0, count)
}

const LINES_PREFIX_BYTES = 128 * 1024

/**
 * Reads at most {@link maxBytes} bytes from the start of a file.
 * Uses Bun.file().slice() so only the requested prefix is loaded from disk,
 * avoiding multi-megabyte allocations for large transcript files.
 */
export async function getCachedPrefix(path: string, maxBytes: number): Promise<string> {
  try {
    const s = await stat(path)
    const identity = { mtimeMs: s.mtimeMs, size: s.size, ino: inodeOf(s) }
    const now = Date.now()
    const cacheKey = `${path}\0prefix:${maxBytes}`

    const cached = FILE_CACHE.get(cacheKey)
    if (cached && now - s.mtimeMs > TWO_HOURS_MS && fingerprintMatches(cached, identity)) {
      return cached.content
    }

    const file = Bun.file(path)
    const content = await file.slice(0, maxBytes).text()

    admit(cacheKey, content, identity)
    return content
  } catch {
    return ""
  }
}

export function clearFileCache(): void {
  FILE_CACHE.clear()
}
