import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { getHomeDir } from "../home.ts"
import {
  getLaunchAgentPlistPath,
  isLaunchAgentLoaded,
  launchAgentExists,
  loadLaunchAgent,
  SWIZ_DAEMON_LABEL,
  unloadLaunchAgent,
} from "../launch-agents.ts"
import { projectKeyFromCwd } from "../project-key.ts"
import { createDefaultTaskStore } from "../task-roots.ts"
import type { Command } from "../types.ts"

const HOME = getHomeDir()
const CLAUDE_DIR = join(HOME, ".claude")
const GEMINI_DIR = join(HOME, ".gemini")
const GEMINI_SETTINGS_BAK = join(GEMINI_DIR, "settings.json.bak")
const GEMINI_TMP_DIR = join(GEMINI_DIR, "tmp")
const DAEMON_LABEL = SWIZ_DAEMON_LABEL

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

import { BOLD, DIM, GREEN, RESET, YELLOW } from "../ansi.ts"

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

type DaemonStopState = "not-installed" | "not-running" | "stopped" | "failed"

async function stopDaemonForCleanup(): Promise<DaemonStopState> {
  const plistPath = getLaunchAgentPlistPath(DAEMON_LABEL)
  if (!(await launchAgentExists(DAEMON_LABEL))) return "not-installed"
  if (!(await isLaunchAgentLoaded(DAEMON_LABEL))) return "not-running"
  return (await unloadLaunchAgent(plistPath)) === 0 ? "stopped" : "failed"
}

async function restartDaemonAfterCleanup(): Promise<boolean> {
  if (!(await launchAgentExists(DAEMON_LABEL))) return false
  return (await loadLaunchAgent(getLaunchAgentPlistPath(DAEMON_LABEL))) === 0
}

// ─── Claude backup detection ──────────────────────────────────────────────────

interface ClaudeBackupInfo {
  files: string[]
  sizeBytes: number
  fileCount: number
}

async function addBackupFile(
  filePath: string,
  target: { files: string[]; sizeBytes: number; fileCount: number }
): Promise<void> {
  try {
    const s = await stat(filePath)
    if (!s.isFile()) return
    target.files.push(filePath)
    target.sizeBytes += s.size
    target.fileCount += 1
  } catch {
    // Skip unreadable files.
  }
}

async function findClaudeBackups(): Promise<ClaudeBackupInfo> {
  const backup: ClaudeBackupInfo = { files: [], sizeBytes: 0, fileCount: 0 }

  try {
    const entries = await readdir(CLAUDE_DIR, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const name = entry.name
      if (name === "settings.json.backup" || name.startsWith("settings.json.bak")) {
        await addBackupFile(join(CLAUDE_DIR, name), backup)
      }
    }
  } catch {
    // ~/.claude doesn't exist or is unreadable
  }

  return backup
}

// ─── Gemini backup detection ──────────────────────────────────────────────────

interface GeminiBackupInfo {
  files: string[]
  sizeBytes: number
  fileCount: number
}

async function collectBakFiles(
  dirPath: string,
  target: GeminiBackupInfo,
  recurseIntoSubdirs: boolean
): Promise<void> {
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => null)
  if (!entries) return

  for (const entry of entries) {
    const entryPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      if (recurseIntoSubdirs) {
        await collectBakFiles(entryPath, target, false)
      }
      continue
    }

    if (entry.isFile() && entry.name.endsWith(".bak")) {
      await addBackupFile(entryPath, target)
    }
  }
}

async function findGeminiBackups(): Promise<GeminiBackupInfo> {
  const backup: GeminiBackupInfo = { files: [], sizeBytes: 0, fileCount: 0 }

  // Check for settings.json.bak
  await addBackupFile(GEMINI_SETTINGS_BAK, backup)

  // Check for *.bak files in ~/.gemini/tmp/**
  await collectBakFiles(GEMINI_TMP_DIR, backup, true)

  return backup
}

// ─── Session discovery ───────────────────────────────────────────────────────

interface SessionInfo {
  sessionId: string
  paths: string[] // All paths associated with this session in projectsDir
  mtimeMs: number
  sizeBytes: number
  taskDirPath: string | null
  taskDirSizeBytes: number
}

interface OldTaskFileInfo {
  sessionId: string
  taskId: string
  status: string
  path: string
  sizeBytes: number
}

function sessionBytes(sessions: SessionInfo[]): number {
  return sessions.reduce((sum, session) => sum + session.sizeBytes + session.taskDirSizeBytes, 0)
}

function sessionTaskDirCount(sessions: SessionInfo[]): number {
  return sessions.filter((session) => session.taskDirPath !== null).length
}

function partitionByCutoff(
  sessions: SessionInfo[],
  cutoffMs: number
): { keep: SessionInfo[]; old: SessionInfo[] } {
  const keep: SessionInfo[] = []
  const old: SessionInfo[] = []
  for (const session of sessions) {
    if (session.mtimeMs < cutoffMs) old.push(session)
    else keep.push(session)
  }
  return { keep, old }
}

function backupLabel(scope: "Claude" | "Gemini", count: number): string {
  return `${scope} backup ${count === 1 ? "file" : "files"}`
}

function parseTaskAgeMs(task: {
  statusChangedAt?: string
  completionTimestamp?: string
}): number | null {
  const candidates = [task.completionTimestamp, task.statusChangedAt]
  for (const candidate of candidates) {
    if (!candidate) continue
    const ms = Date.parse(candidate)
    if (!Number.isNaN(ms)) return ms
  }
  return null
}

async function findOldTaskFiles(
  tasksDir: string,
  cutoffMs: number,
  allowedSessionIds?: Set<string>
): Promise<OldTaskFileInfo[]> {
  const oldTaskFiles: OldTaskFileInfo[] = []
  let sessionEntries: string[] = []
  try {
    sessionEntries = await readdir(tasksDir)
  } catch {
    return oldTaskFiles
  }

  for (const sessionId of sessionEntries) {
    if (allowedSessionIds && !allowedSessionIds.has(sessionId)) continue
    const sessionDir = join(tasksDir, sessionId)
    let sessionDirStat: Awaited<ReturnType<typeof stat>>
    try {
      sessionDirStat = await stat(sessionDir)
    } catch {
      continue
    }
    if (!sessionDirStat.isDirectory()) continue

    let files: string[] = []
    try {
      files = await readdir(sessionDir)
    } catch {
      continue
    }

    for (const file of files) {
      if (!file.endsWith(".json") || file.startsWith(".") || file === "compact-snapshot.json") {
        continue
      }
      const filePath = join(sessionDir, file)
      let fileStat: Awaited<ReturnType<typeof stat>>
      try {
        fileStat = await stat(filePath)
      } catch {
        continue
      }
      if (!fileStat.isFile()) continue

      let task:
        | {
            id?: string
            status?: string
            statusChangedAt?: string
            completionTimestamp?: string
          }
        | undefined
      try {
        task = JSON.parse(await readFile(filePath, "utf-8")) as {
          id?: string
          status?: string
          statusChangedAt?: string
          completionTimestamp?: string
        }
      } catch {
        continue
      }
      if (!task.status) continue
      const taskMs = parseTaskAgeMs(task) ?? fileStat.mtimeMs
      if (taskMs >= cutoffMs) continue

      oldTaskFiles.push({
        sessionId,
        taskId: task.id ?? file.slice(0, -5),
        status: task.status,
        path: filePath,
        sizeBytes: fileStat.size,
      })
    }
  }

  return oldTaskFiles
}

async function findSessions(
  projectDir: string,
  cutoffMs: number,
  tasksDir = createDefaultTaskStore().tasksDir
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
    const taskDirPath = join(tasksDir, sessionId)
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
  taskOlderThanMs: number | null
  taskOlderThanLabel: string | null
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
  let taskOlderThan: { ms: number; label: string } | null = null
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
    } else if (arg === "--task-older-than" && next) {
      taskOlderThan = parseOlderThan(next)
      i++
    } else if (arg === "--project" && next) {
      projectFilter = next
      i++
    }
  }

  return {
    olderThanMs: olderThan.ms,
    olderThanLabel: olderThan.label,
    taskOlderThanMs: taskOlderThan?.ms ?? null,
    taskOlderThanLabel: taskOlderThan?.label ?? null,
    dryRun,
    projectFilter,
  }
}

// ─── Command ─────────────────────────────────────────────────────────────────

export const cleanupCommand: Command = {
  name: "cleanup",
  description: "Remove old Claude Code session data and Gemini backup artifacts",
  usage:
    "swiz cleanup [--older-than <time>] [--task-older-than <time>] [--dry-run] [--project <name>]",
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
    {
      flags: "--task-older-than <time>",
      description:
        "Also remove completed/cancelled task files older than this time (days/hours). Example: 30d, 168h",
    },
  ],

  async run(args: string[]) {
    const {
      olderThanMs,
      olderThanLabel,
      taskOlderThanMs,
      taskOlderThanLabel,
      dryRun,
      projectFilter,
    } = parseCleanupArgs(args)
    const { projectsDir, tasksDir } = createDefaultTaskStore()

    const cutoffMs = Date.now() - olderThanMs
    const taskCutoffMs = taskOlderThanMs ? Date.now() - taskOlderThanMs : null

    // Discover project dirs
    let projectNames: string[]
    try {
      const entries = await readdir(projectsDir, { withFileTypes: true })
      projectNames = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((name) => !projectFilter || name === projectFilter)
        .sort()
    } catch {
      console.log(`No projects directory found at ${projectsDir}`)
      return
    }

    if (projectFilter && projectNames.length === 0) {
      throw new Error(`Project "${projectFilter}" not found in ${projectsDir}`)
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
      const { keep, old } = await findSessions(join(projectsDir, name), cutoffMs, tasksDir)
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

    const scopedSessionIds = new Set<string>()
    for (const result of results) {
      for (const session of result.keep) scopedSessionIds.add(session.sessionId)
      for (const session of result.old) scopedSessionIds.add(session.sessionId)
    }
    const oldTaskFiles =
      taskCutoffMs === null
        ? []
        : await findOldTaskFiles(
            tasksDir,
            taskCutoffMs,
            projectFilter ? scopedSessionIds : undefined
          )
    const oldTaskBytes = oldTaskFiles.reduce((sum, task) => sum + task.sizeBytes, 0)

    // Scan tasksDir for orphans (task directories without matching session in projects)
    if (!projectFilter) {
      const allKnownSessionIds = new Set<string>()
      for (const r of results) {
        for (const s of r.keep) allKnownSessionIds.add(s.sessionId)
        for (const s of r.old) allKnownSessionIds.add(s.sessionId)
      }

      let taskEntries: string[] = []
      try {
        taskEntries = await readdir(tasksDir)
      } catch {}

      const orphans: SessionInfo[] = []
      for (const entry of taskEntries) {
        if (!UUID_RE.test(entry)) continue
        if (allKnownSessionIds.has(entry)) continue

        const taskDirPath = join(tasksDir, entry)
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
        const { keep, old } = partitionByCutoff(orphans, cutoffMs)
        if (keep.length > 0 || old.length > 0) {
          results.push({ name: "(orphaned tasks)", keep, old, stale: true })
        }
      }
    }

    // Discover Claude and Gemini backup artifacts
    const [claudeBackups, geminiBackups] = await Promise.all([
      findClaudeBackups(),
      findGeminiBackups(),
    ])

    if (results.length === 0 && claudeBackups.fileCount === 0 && geminiBackups.fileCount === 0) {
      console.log(`No session directories found (older than ${olderThanLabel}).`)
      console.log(`No Claude or Gemini backup artifacts found.`)
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
      const keepBytes = sessionBytes(keep)
      const oldBytes = sessionBytes(old)
      const oldTaskDirCount = sessionTaskDirCount(old)
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

    // Print Claude backup information
    if (claudeBackups.fileCount > 0) {
      console.log(`  ${BOLD}~/.claude/ (backup artifacts)${RESET}`)
      console.log(
        `    ${YELLOW}${claudeBackups.fileCount} backup ${claudeBackups.fileCount === 1 ? "file" : "files"}${RESET} (${formatBytes(claudeBackups.sizeBytes)})`
      )
      console.log()
    }

    // Print Gemini backup information
    if (geminiBackups.fileCount > 0) {
      console.log(`  ${BOLD}~/.gemini/ (backup artifacts)${RESET}`)
      console.log(
        `    ${YELLOW}${geminiBackups.fileCount} backup ${geminiBackups.fileCount === 1 ? "file" : "files"}${RESET} (${formatBytes(geminiBackups.sizeBytes)})`
      )
      console.log()
    }

    if (taskCutoffMs !== null) {
      const taskLabel = taskOlderThanLabel ?? "specified window"
      console.log(`  ${BOLD}~/.claude/tasks/ (old task files)${RESET}`)
      const taskCountLabel = oldTaskFiles.length === 1 ? "file" : "files"
      const taskPart =
        oldTaskFiles.length > 0
          ? `${YELLOW}${oldTaskFiles.length} task ${taskCountLabel}${RESET} (${formatBytes(oldTaskBytes)})`
          : `${DIM}0 task files${RESET}`
      console.log(`    ${taskPart} older than ${taskLabel}`)
      console.log()
    }

    if (
      totalOldCount === 0 &&
      oldTaskFiles.length === 0 &&
      claudeBackups.fileCount === 0 &&
      geminiBackups.fileCount === 0
    ) {
      console.log(
        `  ${GREEN}No sessions older than ${olderThanLabel}, no old task files, and no Claude or Gemini backups found.${RESET}`
      )
      return
    }

    const taskSuffix =
      totalOldTaskDirs > 0
        ? ` + ${totalOldTaskDirs} task ${totalOldTaskDirs === 1 ? "dir" : "dirs"}`
        : ""
    const claudePart =
      claudeBackups.fileCount > 0
        ? ` + ${claudeBackups.fileCount} ${backupLabel("Claude", claudeBackups.fileCount)}`
        : ""
    const geminiPart =
      geminiBackups.fileCount > 0
        ? ` + ${geminiBackups.fileCount} ${backupLabel("Gemini", geminiBackups.fileCount)}`
        : ""
    const oldTaskPart = oldTaskFiles.length > 0 ? ` + ${oldTaskFiles.length} old task files` : ""
    const totalBytes =
      totalOldBytes + oldTaskBytes + claudeBackups.sizeBytes + geminiBackups.sizeBytes
    console.log(
      `  Total: ${BOLD}${totalOldCount} sessions${RESET}${taskSuffix}${oldTaskPart}${claudePart}${geminiPart} trashable, ~${formatBytes(totalBytes)}`
    )
    console.log()

    if (dryRun) {
      console.log(`  ${DIM}Run without --dry-run to proceed.${RESET}`)
      return
    }

    const daemonStopState = await stopDaemonForCleanup()
    if (daemonStopState === "stopped") {
      console.log(`  ${DIM}Stopped ${DAEMON_LABEL} before cleanup.${RESET}`)
    } else if (daemonStopState === "failed") {
      console.log(`  ${YELLOW}Warning: failed to stop ${DAEMON_LABEL}; continuing cleanup.${RESET}`)
    }

    // Trash sessions and their matching task directories
    try {
      console.log(
        `  Moving ${totalOldCount} session(s)${taskSuffix}${oldTaskPart}${claudePart}${geminiPart} to Trash...`
      )
      let succeeded = 0
      let failed = 0
      let taskDirsRemoved = 0
      let claudeFilesRemoved = 0
      let claudeFailed = 0
      let geminiFilesRemoved = 0
      let geminiFailed = 0
      let oldTaskFilesRemoved = 0
      let oldTaskFilesFailed = 0

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

      // Trash Claude backup artifacts
      for (const backupFile of claudeBackups.files) {
        if (await trashDir(backupFile)) {
          claudeFilesRemoved++
        } else {
          claudeFailed++
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

      for (const taskFile of oldTaskFiles) {
        if (await trashDir(taskFile.path)) {
          oldTaskFilesRemoved++
        } else {
          oldTaskFilesFailed++
        }
      }

      console.log()
      const taskDirNote = taskDirsRemoved > 0 ? ` + ${taskDirsRemoved} task dir(s)` : ""
      const claudeNote =
        claudeFilesRemoved > 0
          ? ` + ${claudeFilesRemoved} ${backupLabel("Claude", claudeFilesRemoved)}`
          : ""
      const geminiNote =
        geminiFilesRemoved > 0
          ? ` + ${geminiFilesRemoved} ${backupLabel("Gemini", geminiFilesRemoved)}`
          : ""
      const oldTaskNote =
        oldTaskFilesRemoved > 0
          ? ` + ${oldTaskFilesRemoved} old task ${oldTaskFilesRemoved === 1 ? "file" : "files"}`
          : ""
      console.log(
        `  ${GREEN}${BOLD}Done.${RESET} ${succeeded} session(s)${taskDirNote}${oldTaskNote}${claudeNote}${geminiNote} moved to Trash (~${formatBytes(totalBytes)} reclaimed).`
      )
      if (failed > 0 || oldTaskFilesFailed > 0 || claudeFailed > 0 || geminiFailed > 0) {
        const failedSessions = failed > 0 ? `${failed} session(s)` : ""
        const failedTaskFiles =
          oldTaskFilesFailed > 0
            ? `${oldTaskFilesFailed} old task ${oldTaskFilesFailed === 1 ? "file" : "files"}`
            : ""
        const failedClaude =
          claudeFailed > 0 ? `${claudeFailed} ${backupLabel("Claude", claudeFailed)}` : ""
        const failedGemini =
          geminiFailed > 0 ? `${geminiFailed} ${backupLabel("Gemini", geminiFailed)}` : ""
        const failedJoined = [failedSessions, failedTaskFiles, failedClaude, failedGemini]
          .filter((s) => s)
          .join(" + ")
        console.log(
          `  ${YELLOW}${failedJoined} could not be trashed — is the \`trash\` CLI installed?${RESET}`
        )
      }
    } finally {
      if (daemonStopState === "stopped") {
        const restarted = await restartDaemonAfterCleanup()
        if (restarted) {
          console.log(`  ${DIM}Restarted ${DAEMON_LABEL} after cleanup.${RESET}`)
        } else {
          console.log(
            `  ${YELLOW}Warning: failed to restart ${DAEMON_LABEL}; run 'swiz daemon --install' if needed.${RESET}`
          )
        }
      }
    }
  },
}
