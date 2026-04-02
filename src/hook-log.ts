/**
 * Structured JSONL logging for hook dispatch events.
 *
 * Each line in ~/.swiz/hook-logs.jsonl is a self-contained JSON record
 * capturing one hook execution: event, hook file, status, duration, etc.
 *
 * The log is append-only and capped at ~10k lines to prevent unbounded growth.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { getHomeDirOrNull } from "./home.ts"
import { splitJsonlLines } from "./utils/jsonl.ts"

export interface HookLogEntry {
  ts: string
  event: string
  hookEventName: string
  hook: string
  status: string
  durationMs: number
  exitCode: number | null
  matcher?: string
  sessionId?: string
  cwd?: string
  toolName?: string
  skipReason?: string
  stdoutSnippet?: string
  stderrSnippet?: string
  /** "hook" (default) for individual hook runs, "dispatch" for overall dispatch summary */
  kind?: "hook" | "dispatch"
  /** Number of hooks executed in this dispatch (only set when kind === "dispatch") */
  hookCount?: number
}

const MAX_LOG_LINES = 10_000

function getLogPath(): string | null {
  const home = getHomeDirOrNull()
  if (!home) return null
  return join(home, ".swiz", "hook-logs.jsonl")
}

export async function appendHookLog(entry: HookLogEntry): Promise<void> {
  return appendHookLogs([entry])
}

export async function appendHookLogs(entries: HookLogEntry[]): Promise<void> {
  if (entries.length === 0) return
  const logPath = getLogPath()
  if (!logPath) return
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    const lines = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`
    appendFileSync(logPath, lines)
  } catch {
    // Never block on log write failure
  }
}

export async function readHookLogs(limit = 200): Promise<HookLogEntry[]> {
  const logPath = getLogPath()
  if (!logPath) return []
  try {
    const file = Bun.file(logPath)
    if (!(await file.exists())) return []
    const text = await file.text()
    // Slice raw lines before parsing to avoid JSON.parse on discarded lines
    const lines = splitJsonlLines(text)
    const recent = lines.slice(-limit).join("\n")
    const entries: HookLogEntry[] = []
    for (const line of splitJsonlLines(recent)) {
      const parsed = JSON.parse(line) as HookLogEntry
      entries.push(parsed)
    }
    return entries
  } catch {
    return []
  }
}

export async function pruneHookLogs(): Promise<void> {
  const logPath = getLogPath()
  if (!logPath) return
  try {
    const file = Bun.file(logPath)
    if (!(await file.exists())) return
    const text = await file.text()
    const lines = splitJsonlLines(text)
    if (lines.length <= MAX_LOG_LINES) return
    const trimmed = lines.slice(-MAX_LOG_LINES)
    await Bun.write(logPath, `${trimmed.join("\n")}\n`)
  } catch {
    // Best-effort
  }
}
