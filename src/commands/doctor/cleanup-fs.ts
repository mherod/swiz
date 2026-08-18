/**
 * Filesystem measurement helpers shared by the `swiz doctor clean` scanners.
 * Kept separate so provider-specific scanners (Claude projects, Antigravity
 * brain/conversation dirs) can size and age directories without importing the
 * full cleanup command module.
 */
import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"

export interface DirStats {
  sizeBytes: number
  newestMtimeMs: number
}

/**
 * Recursively total the byte size and newest mtime of a path. Unreadable
 * entries are skipped rather than failing the whole scan.
 */
export async function pathStats(path: string): Promise<DirStats> {
  let s: Awaited<ReturnType<typeof stat>>
  try {
    s = await stat(path)
  } catch {
    return { sizeBytes: 0, newestMtimeMs: 0 }
  }

  if (!s.isDirectory()) {
    return { sizeBytes: s.size, newestMtimeMs: s.mtimeMs }
  }

  const result: DirStats = { sizeBytes: 0, newestMtimeMs: s.mtimeMs }
  let entries: string[]
  try {
    entries = await readdir(path)
  } catch {
    return result
  }

  for (const entry of entries) {
    const child = await pathStats(join(path, entry))
    result.sizeBytes += child.sizeBytes
    if (child.newestMtimeMs > result.newestMtimeMs) result.newestMtimeMs = child.newestMtimeMs
  }
  return result
}

/** Recursive byte size of a directory; 0 when unreadable. */
export async function dirSize(dirPath: string): Promise<number> {
  return (await pathStats(dirPath)).sizeBytes
}

/**
 * A single cleanable agent session: its on-disk paths plus any Claude task
 * directory that shares the session id.
 */
export interface SessionInfo {
  sessionId: string
  paths: string[]
  mtimeMs: number
  sizeBytes: number
  taskDirPath: string | null
  taskDirSizeBytes: number
}

/** A named group of sessions split into retained and trashable buckets. */
export interface ProjectResult {
  name: string
  keep: SessionInfo[]
  old: SessionInfo[]
  stale: boolean
}
