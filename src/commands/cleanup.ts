import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { projectKeyFromCwd } from "../transcript-utils.ts"
import type { Command } from "../types.ts"

const HOME = process.env.HOME ?? "~"
const PROJECTS_DIR = join(HOME, ".claude", "projects")
const TASKS_DIR = join(HOME, ".claude", "tasks")
const GEMINI_DIR = join(HOME, ".gemini")
const GEMINI_SETTINGS_BAK = join(GEMINI_DIR, "settings.json.bak")
const GEMINI_TMP_DIR = join(GEMINI_DIR, "tmp")

// ─── Path decoding ────────────────────────────────────────────────────────────

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

export async function decodeProjectPath(encodedName: string, homeDir = HOME): Promise<string> {
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

// Matches standard UUID v4 — session dirs only; named dirs (memory/, etc.) never match
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─── ANSI ────────────────────────────────────────────────────────────────────

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`
}

async function dirSize(dirPath: string): Promise<number> {
  let total = 0
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const p = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        total += await dirSize(p)
      } else {
        try {
          total += (await stat(p)).size
        } catch {
          // skip unreadable files
        }
      }
    }
  } catch {
    // skip unreadable dirs
  }
  return total
}

async function trashDir(path: string): Promise<boolean> {
  const proc = Bun.spawn(["trash", path], { stdout: "pipe", stderr: "pipe" })
  await proc.exited
  return proc.exitCode === 0
}

// ─── Gemini backup detection ──────────────────────────────────────────────────

interface GeminiBackupInfo {
  files: string[]
  sizeBytes: number
  fileCount: number
}

async function findGeminiBackups(): Promise<GeminiBackupInfo> {
  const files: string[] = []
  let sizeBytes = 0
  let fileCount = 0

  // Check for settings.json.bak
  try {
    const s = await stat(GEMINI_SETTINGS_BAK)
    if (s.isFile()) {
      files.push(GEMINI_SETTINGS_BAK)
      sizeBytes += s.size
      fileCount += 1
    }
  } catch {
    // File doesn't exist, that's fine
  }

  // Check for *.bak files in ~/.gemini/tmp/**
  try {
    const tmpEntries = await readdir(GEMINI_TMP_DIR, { withFileTypes: true })
    for (const entry of tmpEntries) {
      const entryPath = join(GEMINI_TMP_DIR, entry.name)
      if (entry.isDirectory()) {
        // Recursively scan subdirectories
        const subEntries = await readdir(entryPath, { withFileTypes: true })
        for (const subEntry of subEntries) {
          if (subEntry.name.endsWith(".bak") && subEntry.isFile()) {
            const filePath = join(entryPath, subEntry.name)
            try {
              const s = await stat(filePath)
              files.push(filePath)
              sizeBytes += s.size
              fileCount += 1
            } catch {
              // Skip unreadable files
            }
          }
        }
      } else if (entry.name.endsWith(".bak") && entry.isFile()) {
        // Also check direct tmp directory
        try {
          const s = await stat(entryPath)
          files.push(entryPath)
          sizeBytes += s.size
          fileCount += 1
        } catch {
          // Skip unreadable files
        }
      }
    }
  } catch {
    // tmp directory doesn't exist or is unreadable, that's fine
  }

  return { files, sizeBytes, fileCount }
}

// ─── Session discovery ───────────────────────────────────────────────────────

interface SessionInfo {
  sessionId: string
  paths: string[] // All paths associated with this session in PROJECTS_DIR
  mtimeMs: number
  sizeBytes: number
  taskDirPath: string | null
  taskDirSizeBytes: number
}

async function findSessions(
  projectDir: string,
  cutoffMs: number
): Promise<{ keep: SessionInfo[]; old: SessionInfo[] }> {
  const keep: SessionInfo[] = []
  const old: SessionInfo[] = []

  let entries: string[]
  try {
    entries = await readdir(projectDir)
  } catch {
    return { keep, old }
  }

  // Group entries by sessionId (UUID)
  const sessionMap = new Map<string, { paths: string[]; mtime: number; size: number }>()

  for (const entry of entries) {
    let sessionId: string | undefined
    let isDirectory = false

    const p = join(projectDir, entry)
    let s: Awaited<ReturnType<typeof stat>>
    try {
      s = await stat(p)
      isDirectory = s.isDirectory()
    } catch {
      continue
    }

    if (isDirectory && UUID_RE.test(entry)) {
      sessionId = entry
    } else if (!isDirectory && entry.endsWith(".jsonl")) {
      const id = entry.slice(0, -6)
      if (UUID_RE.test(id)) {
        sessionId = id
      }
    }

    if (sessionId) {
      const existing = sessionMap.get(sessionId) ?? { paths: [], mtime: 0, size: 0 }
      existing.paths.push(p)
      existing.mtime = Math.max(existing.mtime, s.mtimeMs)
      existing.size += isDirectory ? await dirSize(p) : s.size
      sessionMap.set(sessionId, existing)
    }
  }

  for (const [sessionId, data] of sessionMap) {
    const taskDirPath = join(TASKS_DIR, sessionId)
    let taskDirSizeBytes = 0
    let taskDirExists = false
    try {
      const tStat = await stat(taskDirPath)
      if (tStat.isDirectory()) {
        taskDirExists = true
        taskDirSizeBytes = await dirSize(taskDirPath)
      }
    } catch {
      // No matching task directory — that's fine
    }

    const info: SessionInfo = {
      sessionId,
      paths: data.paths,
      mtimeMs: data.mtime,
      sizeBytes: data.size,
      taskDirPath: taskDirExists ? taskDirPath : null,
      taskDirSizeBytes,
    }

    if (data.mtime < cutoffMs) {
      old.push(info)
    } else {
      keep.push(info)
    }
  }

  return { keep, old }
}

// ─── Arg Parsing ─────────────────────────────────────────────────────────────

export interface CleanupArgs {
  olderThanMs: number
  olderThanLabel: string
  dryRun: boolean
  projectFilter: string | undefined
}

/** Parse a time value like "7", "7d", or "48h" into milliseconds + display label. */
function parseOlderThan(value: string): { ms: number; label: string } {
  const hoursMatch = /^(\d+)h$/i.exec(value)
  if (hoursMatch) {
    const hours = parseInt(hoursMatch[1]!, 10)
    if (hours < 1) throw new Error("--older-than requires a positive value")
    return { ms: hours * 60 * 60 * 1000, label: `${hours} ${hours === 1 ? "hour" : "hours"}` }
  }

  const daysStr = /^(\d+)d?$/i.exec(value)?.[1] ?? ""
  const days = parseInt(daysStr, 10)
  if (Number.isNaN(days) || days < 1) {
    throw new Error("--older-than requires a positive integer, e.g. 30, 7d, or 48h")
  }
  return { ms: days * 24 * 60 * 60 * 1000, label: `${days} ${days === 1 ? "day" : "days"}` }
}

export function parseCleanupArgs(args: string[]): CleanupArgs {
  let olderThan = parseOlderThan("30")
  let dryRun = false
  let projectFilter: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    const next = args[i + 1]
    if (arg === "--dry-run") {
      dryRun = true
    } else if (arg === "--older-than" && next) {
      olderThan = parseOlderThan(next)
      i++
    } else if (arg === "--project" && next) {
      projectFilter = next
      i++
    }
  }

  return { olderThanMs: olderThan.ms, olderThanLabel: olderThan.label, dryRun, projectFilter }
}

// ─── Command ─────────────────────────────────────────────────────────────────

export const cleanupCommand: Command = {
  name: "cleanup",
  description: "Remove old Claude Code session data and Gemini backup artifacts",
  usage: "swiz cleanup [--older-than <time>] [--dry-run] [--project <name>]",
  options: [
    {
      flags: "--older-than <time>",
      description:
        "Remove Claude sessions older than this time: days (30, 7d) or hours (48h). Default: 30",
    },
    { flags: "--dry-run", description: "Show what would be removed without deleting" },
    {
      flags: "--project <name>",
      description: "Limit Claude cleanup to a specific project directory name",
    },
  ],

  async run(args: string[]) {
    const { olderThanMs, olderThanLabel, dryRun, projectFilter } = parseCleanupArgs(args)

    const cutoffMs = Date.now() - olderThanMs

    // Discover project dirs
    let projectNames: string[]
    try {
      const entries = await readdir(PROJECTS_DIR, { withFileTypes: true })
      projectNames = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((name) => !projectFilter || name === projectFilter)
        .sort()
    } catch {
      console.log(`No projects directory found at ${PROJECTS_DIR}`)
      return
    }

    if (projectFilter && projectNames.length === 0) {
      throw new Error(`Project "${projectFilter}" not found in ${PROJECTS_DIR}`)
    }

    // Scan each project
    interface ProjectResult {
      name: string
      keep: SessionInfo[]
      old: SessionInfo[]
      stale: boolean
    }

    const results: ProjectResult[] = []
    for (const name of projectNames) {
      const { keep, old } = await findSessions(join(PROJECTS_DIR, name), cutoffMs)
      if (keep.length > 0 || old.length > 0) {
        results.push({ name, keep, old, stale: false })
      }
    }

    // Mark projects whose real filesystem path no longer exists.
    const encodedHome = projectKeyFromCwd(HOME)
    for (let i = 0; i < results.length; i++) {
      const name = results[i]!.name
      if (!name.startsWith(encodedHome)) continue
      const encodedRest = name.slice(encodedHome.length)
      if (!encodedRest) continue
      if ((await walkDecode(HOME, encodedRest)) === null) {
        results[i]!.stale = true
        results[i]!.old = [...results[i]!.old, ...results[i]!.keep]
        results[i]!.keep = []
      }
    }

    // Scan TASKS_DIR for orphans (task directories without matching session in projects)
    if (!projectFilter) {
      const allKnownSessionIds = new Set<string>()
      for (const r of results) {
        for (const s of r.keep) allKnownSessionIds.add(s.sessionId)
        for (const s of r.old) allKnownSessionIds.add(s.sessionId)
      }

      let taskEntries: string[] = []
      try {
        taskEntries = await readdir(TASKS_DIR)
      } catch {}

      const orphans: SessionInfo[] = []
      for (const entry of taskEntries) {
        if (!UUID_RE.test(entry)) continue
        if (allKnownSessionIds.has(entry)) continue

        const taskDirPath = join(TASKS_DIR, entry)
        let s: Awaited<ReturnType<typeof stat>>
        try {
          s = await stat(taskDirPath)
          if (!s.isDirectory()) continue
        } catch {
          continue
        }

        orphans.push({
          sessionId: entry,
          paths: [],
          mtimeMs: s.mtimeMs,
          sizeBytes: 0,
          taskDirPath,
          taskDirSizeBytes: await dirSize(taskDirPath),
        })
      }

      if (orphans.length > 0) {
        const keep: SessionInfo[] = []
        const old: SessionInfo[] = []
        for (const o of orphans) {
          if (o.mtimeMs < cutoffMs) old.push(o)
          else keep.push(o)
        }
        if (keep.length > 0 || old.length > 0) {
          results.push({ name: "(orphaned tasks)", keep, old, stale: true })
        }
      }
    }

    // Discover Gemini backup artifacts
    const geminiBackups = await findGeminiBackups()

    if (results.length === 0 && geminiBackups.fileCount === 0) {
      console.log(`No session directories found (older than ${olderThanLabel}).`)
      console.log(`No Gemini backup artifacts found.`)
      return
    }

    // Decode project paths for display
    const decodedNames = await Promise.all(
      results.map((r) => (r.name.startsWith("(") ? r.name : decodeProjectPath(r.name)))
    )
    const maxNameLen = Math.max(...decodedNames.map((n) => n.length), 20)

    // Print Claude cleanup table
    console.log()
    console.log(`  ${BOLD}~/.claude/projects/${RESET}`)

    let totalOldCount = 0
    let totalOldBytes = 0
    let totalOldTaskDirs = 0

    for (let i = 0; i < results.length; i++) {
      const { keep, old, stale } = results[i]!
      const displayName = decodedNames[i]!
      const total = keep.length + old.length
      const keepBytes = keep.reduce((sum, s) => sum + s.sizeBytes + s.taskDirSizeBytes, 0)
      const oldBytes = old.reduce((sum, s) => sum + s.sizeBytes + s.taskDirSizeBytes, 0)
      const oldTaskDirCount = old.filter((s) => s.taskDirPath !== null).length
      totalOldCount += old.length
      totalOldBytes += oldBytes
      totalOldTaskDirs += oldTaskDirCount

      const staleSuffix = stale ? ` ${DIM}(path gone)${RESET}` : ""
      const trashPart =
        old.length > 0
          ? `${YELLOW}${old.length} trashable${RESET} (${formatBytes(oldBytes)})`
          : `${DIM}0 trashable${RESET}`
      const keepPart = `${keep.length} kept (${formatBytes(keepBytes)})`
      console.log(
        `    ${displayName.padEnd(maxNameLen + 2)} ${String(total).padStart(3)} sessions  →  ${keepPart}, ${trashPart}${staleSuffix}`
      )
    }

    console.log()

    // Print Gemini backup information
    if (geminiBackups.fileCount > 0) {
      console.log(`  ${BOLD}~/.gemini/ (backup artifacts)${RESET}`)
      console.log(
        `    ${YELLOW}${geminiBackups.fileCount} backup ${geminiBackups.fileCount === 1 ? "file" : "files"}${RESET} (${formatBytes(geminiBackups.sizeBytes)})`
      )
      console.log()
    }

    if (totalOldCount === 0 && geminiBackups.fileCount === 0) {
      console.log(
        `  ${GREEN}No sessions older than ${olderThanLabel} and no Gemini backups found.${RESET}`
      )
      return
    }

    const taskSuffix =
      totalOldTaskDirs > 0
        ? ` + ${totalOldTaskDirs} task ${totalOldTaskDirs === 1 ? "dir" : "dirs"}`
        : ""
    const geminiPart =
      geminiBackups.fileCount > 0
        ? ` + ${geminiBackups.fileCount} Gemini backup ${geminiBackups.fileCount === 1 ? "file" : "files"}`
        : ""
    const totalBytes = totalOldBytes + geminiBackups.sizeBytes
    console.log(
      `  Total: ${BOLD}${totalOldCount} sessions${RESET}${taskSuffix}${geminiPart} trashable, ~${formatBytes(totalBytes)}`
    )
    console.log()

    if (dryRun) {
      console.log(`  ${DIM}Run without --dry-run to proceed.${RESET}`)
      return
    }

    // Trash sessions and their matching task directories
    console.log(`  Moving ${totalOldCount} session(s)${taskSuffix}${geminiPart} to Trash...`)
    let succeeded = 0
    let failed = 0
    let taskDirsRemoved = 0
    let geminiFilesRemoved = 0
    let geminiFailed = 0

    for (const { old } of results) {
      for (const session of old) {
        let sessionPartSucceeded = false
        if (session.paths.length === 0) {
          // orphan with only task data
          sessionPartSucceeded = true
        } else {
          for (const p of session.paths) {
            if (await trashDir(p)) sessionPartSucceeded = true
            else failed++
          }
        }

        if (sessionPartSucceeded) succeeded++

        if (session.taskDirPath && (await trashDir(session.taskDirPath))) {
          taskDirsRemoved++
        }
      }
    }

    // Trash Gemini backup artifacts
    for (const backupFile of geminiBackups.files) {
      if (await trashDir(backupFile)) {
        geminiFilesRemoved++
      } else {
        geminiFailed++
      }
    }

    console.log()
    const taskDirNote = taskDirsRemoved > 0 ? ` + ${taskDirsRemoved} task dir(s)` : ""
    const geminiNote =
      geminiFilesRemoved > 0
        ? ` + ${geminiFilesRemoved} Gemini backup ${geminiFilesRemoved === 1 ? "file" : "files"}`
        : ""
    console.log(
      `  ${GREEN}${BOLD}Done.${RESET} ${succeeded} session(s)${taskDirNote}${geminiNote} moved to Trash (~${formatBytes(totalBytes)} reclaimed).`
    )
    if (failed > 0 || geminiFailed > 0) {
      const failedSessions = failed > 0 ? `${failed} session(s)` : ""
      const failedGemini =
        geminiFailed > 0
          ? `${geminiFailed} Gemini backup ${geminiFailed === 1 ? "file" : "files"}`
          : ""
      const failedJoined = [failedSessions, failedGemini].filter((s) => s).join(" + ")
      console.log(
        `  ${YELLOW}${failedJoined} could not be trashed — is the \`trash\` CLI installed?${RESET}`
      )
    }
  },
}
