import { stat } from "node:fs/promises"

/**
 * A simple in-memory cache for file contents to avoid repeated reads
 * of stable files (those not modified in the last 2 hours).
 */
const FILE_CACHE = new Map<string, { content: string; mtime: number; cachedAt: number }>()

const TWO_HOURS_MS = 2 * 60 * 60 * 1000

/**
 * Reads a file's content with caching for "stable" files (older than 2 hours).
 *
 * If the file's mtime is older than 2 hours AND we have it in cache with the
 * SAME mtime, we return the cached content without reading the file again.
 *
 * Otherwise, we read the file and update the cache.
 */
export async function getCachedFileText(path: string): Promise<string> {
  try {
    const s = await stat(path)
    const mtime = s.mtimeMs
    const now = Date.now()

    const cached = FILE_CACHE.get(path)

    // If we have a cached version and the file is "stable" (mtime > 2h ago)
    // AND the mtime matches what we have cached, return the cache.
    if (cached && now - mtime > TWO_HOURS_MS && cached.mtime === mtime) {
      return cached.content
    }

    // Otherwise, read the file
    const content = await Bun.file(path).text()

    // Update cache
    FILE_CACHE.set(path, { content, mtime, cachedAt: now })

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
    const mtime = s.mtimeMs
    const now = Date.now()
    const cacheKey = `${path}\0prefix:${maxBytes}`

    const cached = FILE_CACHE.get(cacheKey)
    if (cached && now - mtime > TWO_HOURS_MS && cached.mtime === mtime) {
      return cached.content
    }

    const file = Bun.file(path)
    const content = await file.slice(0, maxBytes).text()

    FILE_CACHE.set(cacheKey, { content, mtime, cachedAt: now })
    return content
  } catch {
    return ""
  }
}

export function clearFileCache(): void {
  FILE_CACHE.clear()
}
