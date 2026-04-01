/**
 * Log rotation and pruning for temporary log files in /tmp.
 *
 * Prevents unbounded growth of:
 * - swiz-dispatch.log
 * - swiz-pseudohooks.log
 * - swiz-prpoll.log
 * - swiz-prpoll-error.log
 *
 * Each log is capped at MAX_LOG_LINES to prevent filesystem issues.
 */

import {
  swizDispatchLogPath,
  swizPrPollErrorLogPath,
  swizPrPollLogPath,
  swizPseudoHookLogPath,
} from "./temp-paths.ts"

const MAX_LOG_LINES = 10_000

interface LogFile {
  path: string
  name: string
}

const LOG_FILES: LogFile[] = [
  { path: swizDispatchLogPath(), name: "dispatch" },
  { path: swizPseudoHookLogPath(), name: "pseudohooks" },
  { path: swizPrPollLogPath(), name: "prpoll" },
  { path: swizPrPollErrorLogPath(), name: "prpoll-error" },
]

/**
 * Prune a single log file to MAX_LOG_LINES, keeping the most recent lines.
 */
async function pruneSingleLog(logPath: string): Promise<void> {
  try {
    const file = Bun.file(logPath)
    if (!(await file.exists())) return

    const content = await file.text()
    const lines = content.split("\n").filter((line) => line.trim().length > 0)

    if (lines.length <= MAX_LOG_LINES) return

    // Keep only the last MAX_LOG_LINES
    const trimmed = lines.slice(-MAX_LOG_LINES)
    await Bun.write(logPath, `${trimmed.join("\n")}\n`)
  } catch {
    // Fail silently — log rotation must not affect system operation
  }
}

/**
 * Prune all temporary log files that exceed MAX_LOG_LINES.
 * Called periodically from daemon monitoring loop.
 */
export async function pruneTempLogs(): Promise<void> {
  try {
    // Prune all logs in parallel
    await Promise.all(LOG_FILES.map((log) => pruneSingleLog(log.path)))
  } catch {
    // Fail silently
  }
}

/**
 * Get the size of a log file in bytes (used for monitoring/metrics).
 */
export async function getLogFileSize(logPath: string): Promise<number> {
  try {
    const file = Bun.file(logPath)
    if (!(await file.exists())) return 0
    return file.size
  } catch {
    return 0
  }
}

/**
 * Get the line count of a log file (used for monitoring/metrics).
 */
export async function getLogFileLineCount(logPath: string): Promise<number> {
  try {
    const file = Bun.file(logPath)
    if (!(await file.exists())) return 0
    const content = await file.text()
    return content.split("\n").filter((line) => line.trim().length > 0).length
  } catch {
    return 0
  }
}
