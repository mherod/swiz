/**
 * Path decoding for encoded `~/.claude/projects` directory names and argv parsing
 * for `swiz doctor cleanup`. Kept separate from the main doctor command to avoid
 * coupling narrow utilities to the full diagnostics surface.
 */
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { getHomeDir } from "../../home.ts"
import { projectKeyFromCwd } from "../../project-key.ts"

// Claude Code encodes project paths by replacing both '/' and '.' with '-'.
// This is lossy: a '-' in the encoded name could be from '/', '.', or a literal '-'.
// We resolve the ambiguity by walking the real filesystem and matching directory
// entries, using longest-match-first so "cheapshot-auto" wins over "cheapshot".

const readdirCache = new Map<string, string[]>()

async function readdirCached(dirPath: string): Promise<string[]> {
  const cached = readdirCache.get(dirPath)
  if (cached) return cached
  try {
    const entries = await readdir(dirPath)
    readdirCache.set(dirPath, entries)
    return entries
  } catch {
    return []
  }
}

export async function walkDecode(
  currentPath: string,
  remainingEncoded: string
): Promise<string | null> {
  if (!remainingEncoded) return currentPath
  if (!remainingEncoded.startsWith("-")) return null

  const encodedFromHere = remainingEncoded.slice(1) // strip leading '-'
  if (!encodedFromHere) return currentPath

  const entries = await readdirCached(currentPath)

  // Each filesystem entry encodes to its name with '/' and '.' replaced by '-'.
  // Find all entries whose encoding is a prefix of encodedFromHere, longest first.
  const candidates = entries
    .map((entry) => ({ entry, encoded: projectKeyFromCwd(entry) }))
    .filter(({ encoded }) => encodedFromHere.startsWith(encoded))
    .sort((a, b) => b.encoded.length - a.encoded.length)

  for (const { entry, encoded } of candidates) {
    const afterEntry = encodedFromHere.slice(encoded.length)
    if (afterEntry === "" || afterEntry.startsWith("-")) {
      const result = await walkDecode(join(currentPath, entry), afterEntry)
      if (result !== null) return result
    }
  }

  return null
}

export async function decodeProjectPath(
  encodedName: string,
  homeDir = getHomeDir()
): Promise<string> {
  const encodedHome = projectKeyFromCwd(homeDir)
  if (!encodedName.startsWith(encodedHome)) return encodedName

  const encodedRest = encodedName.slice(encodedHome.length)
  if (!encodedRest) return "~"

  const decoded = await walkDecode(homeDir, encodedRest)
  if (decoded) {
    return decoded.startsWith(homeDir) ? `~${decoded.slice(homeDir.length)}` : decoded
  }

  // Fallback: simple replacement (may split literal hyphens)
  return `~${encodedRest.replace(/-/g, "/")}`
}

export interface CleanupArgs {
  olderThanMs: number
  olderThanLabel: string
  taskOlderThanMs: number | null
  taskOlderThanLabel: string | null
  dryRun: boolean
  projectFilter: string | undefined
  junieOnly?: boolean
  skipTrash?: boolean
}

/** Parse a time value like "7", "7d", or "48h" into milliseconds + display label. */
export function parseOlderThan(value: string): { ms: number; label: string } {
  const hoursMatch = value.match(/^(\d+)h$/i)
  if (hoursMatch) {
    const hours = parseInt(hoursMatch[1]!, 10)
    if (hours < 1) throw new Error("--older-than requires a positive value")
    return { ms: hours * 60 * 60 * 1000, label: `${hours} ${hours === 1 ? "hour" : "hours"}` }
  }

  const daysMatch = value.match(/^(\d+)d?$/i)
  const daysStr = daysMatch?.[1] ?? ""
  const days = parseInt(daysStr, 10)
  if (Number.isNaN(days) || days < 1) {
    throw new Error("--older-than requires a positive integer, e.g. 30, 7d, or 48h")
  }
  return { ms: days * 24 * 60 * 60 * 1000, label: `${days} ${days === 1 ? "day" : "days"}` }
}

interface CleanupFlagState {
  olderThan: { ms: number; label: string }
  taskOlderThan: { ms: number; label: string } | null
  dryRun: boolean
  projectFilter: string | undefined
  junieOnly: boolean
  skipTrash: boolean
}

function consumeCleanupFlag(
  arg: string,
  next: string | undefined,
  state: CleanupFlagState
): boolean {
  if (arg === "--dry-run") {
    state.dryRun = true
    return false
  }
  if (arg === "--junie-only") {
    state.junieOnly = true
    return false
  }
  if (arg === "--skip-trash") {
    state.skipTrash = true
    return false
  }
  if (arg === "--older-than" && next) {
    state.olderThan = parseOlderThan(next)
    return true
  }
  if (arg === "--task-older-than" && next) {
    state.taskOlderThan = parseOlderThan(next)
    return true
  }
  if (arg === "--project" && next) {
    state.projectFilter = next
    return true
  }
  return false
}

export function parseCleanupArgs(args: string[]): CleanupArgs {
  const state = {
    olderThan: parseOlderThan("30"),
    taskOlderThan: null as { ms: number; label: string } | null,
    dryRun: false,
    projectFilter: undefined as string | undefined,
    junieOnly: false,
    skipTrash: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (consumeCleanupFlag(arg, args[i + 1], state)) i++
  }

  return {
    olderThanMs: state.olderThan.ms,
    olderThanLabel: state.olderThan.label,
    taskOlderThanMs: state.taskOlderThan?.ms ?? null,
    taskOlderThanLabel: state.taskOlderThan?.label ?? null,
    dryRun: state.dryRun,
    projectFilter: state.projectFilter,
    junieOnly: state.junieOnly,
    skipTrash: state.skipTrash,
  }
}
