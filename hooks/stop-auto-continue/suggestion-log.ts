#!/usr/bin/env bun
// Suggestion deduplication and persistence module for stop-auto-continue hook
// Handles loading/saving suggestion records and cleanup of stale dedup files

import { mkdir, readdir, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { uniq } from "lodash-es"
import { getHomeDirOrNull } from "../../src/home.ts"

/**
 * Regex to extract hook/file name references from a suggestion.
 * Matches patterns like: pretooluse-foo-bar, stop-something, posttooluse-xyz,
 * session-start-thing, user-prompt-handler — with optional .ts suffix.
 */
const HOOK_NAME_RE =
  /\b(pre-?tool-?use|post-?tool-?use|stop|session-?start|user-?prompt)[a-z0-9-]+(?:\.ts)?\b/gi

/**
 * Check whether a suggestion references hook/file names that don't exist in
 * the repo file list. Returns a description of the ungrounded reference if
 * found, or null if the suggestion is grounded (or has no file references).
 */
export function isUngroundedSuggestion(suggestionText: string, repoFiles: string): string | null {
  const matches = suggestionText.match(HOOK_NAME_RE)
  if (!matches || matches.length === 0) return null

  const repoFilesLower = repoFiles.toLowerCase()
  const ungrounded = uniq(
    matches
      .map((m) => m.toLowerCase().replace(/\.ts$/, ""))
      .filter((name) => !repoFilesLower.includes(name))
  )

  if (ungrounded.length === 0) return null
  return `Referenced artifacts not in repo: ${ungrounded.join(", ")}`
}

// ─── Suggestion deduplication ─────────────────────────────────────────────

/** Normalize a suggestion to a short dedup key. */
function suggestionKey(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120)
}

export interface SuggestionLog {
  seen: Record<string, number> // key → count
}

function getSuggestionsPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
  const home = getHomeDirOrNull() ?? "/tmp"
  return join(home, ".swiz", `stop-suggestions-${safe}.json`)
}

export function __testOnly_getSuggestionsPath(sessionId: string): string {
  return getSuggestionsPath(sessionId)
}

export async function loadSuggestionLog(sessionId: string): Promise<SuggestionLog> {
  try {
    const raw = await Bun.file(getSuggestionsPath(sessionId)).json()
    if (
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as SuggestionLog).seen === "object"
    ) {
      return raw as SuggestionLog
    }
  } catch {
    // File doesn't exist or is invalid
  }
  return { seen: {} }
}

async function recordSuggestion(sessionId: string, key: string): Promise<number> {
  const log = await loadSuggestionLog(sessionId)
  log.seen[key] = (log.seen[key] ?? 0) + 1
  const path = getSuggestionsPath(sessionId)
  try {
    await mkdir(dirname(path), { recursive: true })
  } catch {}
  await Bun.write(path, JSON.stringify(log))
  return log.seen[key]!
}

export async function __testOnly_recordSuggestion(sessionId: string, key: string): Promise<number> {
  return recordSuggestion(sessionId, key)
}

/** Best-effort cleanup of dedup files older than 7 days or exceeding max count. */
const DEDUP_MAX_FILES = 50
export const __testOnly_DEDUP_MAX_FILES = DEDUP_MAX_FILES

async function unlinkBestEffort(filePath: string): Promise<void> {
  try {
    await unlink(filePath)
  } catch {
    // Best-effort — ignore errors
  }
}

/** Returns file info if the entry is a recent suggestion log; deletes and returns null if stale. */
async function suggestionFileIfRecent(
  swizDir: string,
  entry: string,
  cutoffMs: number
): Promise<{ path: string; mtime: number } | null> {
  if (!entry.startsWith("stop-suggestions-") || !entry.endsWith(".json")) return null
  const filePath = join(swizDir, entry)
  const file = Bun.file(filePath)
  if (!(await file.exists())) return null
  const mtime = file.lastModified
  if (mtime < cutoffMs) {
    await unlinkBestEffort(filePath)
    return null
  }
  return { path: filePath, mtime }
}

async function pruneOldSuggestionLogs(): Promise<void> {
  const home = getHomeDirOrNull()
  if (!home) return
  const swizDir = join(home, ".swiz")
  try {
    const entries = await readdir(swizDir)
    const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000
    const suggestionFiles: { path: string; mtime: number }[] = []
    for (const entry of entries) {
      const row = await suggestionFileIfRecent(swizDir, entry, cutoffMs)
      if (row) suggestionFiles.push(row)
    }
    // Cap total files: delete oldest excess (retain newest DEDUP_MAX_FILES)
    if (suggestionFiles.length > DEDUP_MAX_FILES) {
      suggestionFiles.sort((a, b) => a.mtime - b.mtime)
      for (const file of suggestionFiles.slice(0, suggestionFiles.length - DEDUP_MAX_FILES)) {
        await unlinkBestEffort(file.path)
      }
    }
  } catch {
    // Best-effort — ignore errors
  }
}

/** Exposed for tests — runs the same pruning as the hook's fire-and-forget cleanup. */
export async function __testOnly_pruneOldSuggestionLogs(): Promise<void> {
  await pruneOldSuggestionLogs()
}

/**
 * Public API: Record a suggestion and return the count of times it's been seen.
 * Threshold for dedup is checked in the main hook (DEDUP_MAX_SEEN).
 */
export async function recordSuggestionAndGetCount(
  sessionId: string,
  suggestionText: string
): Promise<number> {
  const key = suggestionKey(suggestionText)
  return recordSuggestion(sessionId, key)
}

/**
 * Public API: Start cleanup of stale suggestion logs (fire-and-forget).
 * Should be called once per hook invocation.
 */
export function startSuggestionLogCleanup(): void {
  void pruneOldSuggestionLogs()
}
