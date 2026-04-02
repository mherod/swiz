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
 * Specialized version for reading the first N lines.
 * Still caches the whole file to simplify the 'stable' file logic.
 */
export async function getCachedLines(path: string, count: number): Promise<string[]> {
  const text = await getCachedFileText(path)
  if (!text) return []
  return text.split("\n").slice(0, count)
}

/**
 * Specialized version for reading a prefix.
 */
export async function getCachedPrefix(path: string, maxBytes: number): Promise<string> {
  const text = await getCachedFileText(path)
  if (!text) return ""
  // Note: this assumes UTF-8 string indexing, which might differ slightly from
  // bytes but should be close enough for prefix matching in these files.
  return text.slice(0, maxBytes)
}
