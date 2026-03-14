/**
 * Cross-process GitHub API rate-limit throttle.
 *
 * Uses a shared file to track request timestamps across all swiz processes
 * (hooks, daemon, CLI commands). Before each `gh` CLI call, callers should
 * `await acquireGhSlot()` to ensure the rolling 1-hour window stays under
 * the GitHub API limit (5000 req/hr authenticated).
 *
 * The throttle file is append-only with periodic compaction. Each line is
 * a Unix-ms timestamp. On read, entries older than 1 hour are ignored.
 */

const THROTTLE_FILE = "/tmp/swiz-gh-rate-limit.log"
const WINDOW_MS = 60 * 60 * 1000 // 1 hour
const MAX_REQUESTS_PER_WINDOW = 4500 // leave 500 buffer below GitHub's 5000
const COMPACTION_THRESHOLD = 10_000 // compact file when line count exceeds this
const RETRY_DELAY_MS = 1_000

// In-process write queue to serialize read-modify-write cycles and prevent
// concurrent acquireGhSlot() calls within the same process from racing.
let writeQueue: Promise<void> = Promise.resolve()

/** Read recent timestamps from the throttle file (within the last hour). */
async function readRecentTimestamps(): Promise<number[]> {
  const cutoff = Date.now() - WINDOW_MS
  try {
    const file = Bun.file(THROTTLE_FILE)
    if (!(await file.exists())) return []
    const raw = await file.text()
    const recent: number[] = []
    for (const line of raw.split("\n")) {
      const ts = Number(line)
      if (ts > cutoff) recent.push(ts)
    }
    return recent
  } catch {
    return []
  }
}

/** Append a timestamp to the throttle file. Compacts when file grows too large. */
async function recordRequestInner(): Promise<void> {
  const now = String(Date.now())
  try {
    const file = Bun.file(THROTTLE_FILE)
    const existing = (await file.exists()) ? await file.text() : ""
    await Bun.write(THROTTLE_FILE, `${existing}${now}\n`)
  } catch {
    try {
      await Bun.write(THROTTLE_FILE, `${now}\n`)
    } catch {
      // Best-effort
    }
  }

  // Periodic compaction: rewrite file with only recent entries
  try {
    const raw = await Bun.file(THROTTLE_FILE).text()
    const lineCount = raw.split("\n").length
    if (lineCount > COMPACTION_THRESHOLD) {
      const cutoff = Date.now() - WINDOW_MS
      const recent = raw
        .split("\n")
        .filter((l) => Number(l) > cutoff)
        .join("\n")
      await Bun.write(THROTTLE_FILE, recent ? `${recent}\n` : "")
    }
  } catch {
    // Compaction is best-effort
  }
}

/** Serialized record — prevents in-process write races. */
function recordRequest(): Promise<void> {
  writeQueue = writeQueue.then(recordRequestInner, recordRequestInner)
  return writeQueue
}

/**
 * Acquire a slot in the rate-limit window before making a `gh` API call.
 * Returns immediately if under budget. Waits with 1s retries if at capacity.
 * Times out after 30s to avoid indefinite blocking.
 */
export async function acquireGhSlot(): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const recent = await readRecentTimestamps()
    if (recent.length < MAX_REQUESTS_PER_WINDOW) {
      await recordRequest()
      return
    }
    // At capacity — wait for oldest entry to age out
    await Bun.sleep(RETRY_DELAY_MS)
  }
  // Timed out waiting — proceed anyway to avoid blocking indefinitely
  await recordRequest()
}

/** Get current usage stats for diagnostics. */
export async function getGhRateLimitStats(): Promise<{
  used: number
  limit: number
  remaining: number
}> {
  const recent = await readRecentTimestamps()
  return {
    used: recent.length,
    limit: MAX_REQUESTS_PER_WINDOW,
    remaining: Math.max(0, MAX_REQUESTS_PER_WINDOW - recent.length),
  }
}
