/**
 * File-based locking utility for coordinating multiple processes.
 * Uses Bun.file() and Bun.write() with process PID for ownership.
 */

import { createHash } from "node:crypto"
import { open } from "node:fs/promises"
import { join } from "node:path"
import { TMP_ROOT } from "../temp-paths.ts"

const LOCK_STALE_MS = 30_000
const HEARTBEAT_MS = 5_000

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Generates a deterministic lock file path for any given file path.
 * Used to ensure that concurrent operations on the same logical file
 * are coordinated.
 */
export function getLockPathForFile(filePath: string): string {
  // Use a hash of the absolute path to create a safe filename in /tmp
  const hash = createHash("sha256").update(filePath).digest("hex").slice(0, 16)
  return join(TMP_ROOT, `swiz-file-${hash}.lock`)
}

async function clearStaleLock(lockFile: string): Promise<void> {
  try {
    const file = Bun.file(lockFile)
    if (!(await file.exists())) return

    const content = (await file.text()).trim()
    const ownerPid = parseInt(content, 10)
    const stats = await file.stat()
    const age = Date.now() - stats.mtime.getTime()

    if (!Number.isNaN(ownerPid) && pidAlive(ownerPid) && age < LOCK_STALE_MS) return
    await file.delete()
  } catch {
    // Lock doesn't exist or can't be read — nothing to clear
  }
}

/**
 * Acquire a file-based lock. Returns true if acquired, false on timeout.
 */
export async function acquireLock(lockFile: string, timeoutMs = 10_000): Promise<boolean> {
  await clearStaleLock(lockFile)
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const handle = await open(lockFile, "wx")
      try {
        await handle.writeFile(String(process.pid))
      } finally {
        await handle.close()
      }
      return true
    } catch {
      // Another process grabbed it — retry
    }
    await clearStaleLock(lockFile)
    await Bun.sleep(200)
  }
  return false
}

/**
 * Updates the lock file mtime to prevent it from becoming stale.
 */
export async function heartbeat(lockFile: string): Promise<void> {
  try {
    await Bun.write(lockFile, String(process.pid))
  } catch {
    // Lock was removed — heartbeat no longer needed
  }
}

/**
 * Executes a function with a file lock.
 */
export async function withFileLock<T>(
  lockFile: string,
  fn: () => Promise<T>,
  timeoutMs = 10_000
): Promise<T> {
  if (!(await acquireLock(lockFile, timeoutMs))) {
    throw new Error(`Failed to acquire lock: ${lockFile}`)
  }

  const heartbeatInterval = setInterval(() => {
    heartbeat(lockFile).catch(() => {})
  }, HEARTBEAT_MS)

  try {
    return await fn()
  } finally {
    clearInterval(heartbeatInterval)
    try {
      await Bun.file(lockFile).delete()
    } catch {
      // Already cleared
    }
  }
}
