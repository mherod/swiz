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

  async function processTaskFile(
    sessionId: string,
    sessionDir: string,
    file: string,
    cutoffMs: number
  ): Promise<OldTaskFileInfo | null> {
    if (!file.endsWith(".json") || file.startsWith(".") || file === "compact-snapshot.json") {
      return null
    }
    const filePath = join(sessionDir, file)
    let fileStat: Awaited<ReturnType<typeof stat>>
    try {
      fileStat = await stat(filePath)
    } catch {
      return null
    }
    if (!fileStat.isFile()) return null

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
      return null
    }
    if (!task.status) return null
    const taskMs = parseTaskAgeMs(task) ?? fileStat.mtimeMs
    if (taskMs >= cutoffMs) return null

    return {
      sessionId,
      taskId: task.id ?? file.slice(0, -5),
      status: task.status,
      path: filePath,
      sizeBytes: fileStat.size,
    }
  }

  async function processSessionDir(
    sessionId: string,
    tasksDir: string,
    cutoffMs: number
  ): Promise<OldTaskFileInfo[]> {
    const oldTaskFiles: OldTaskFileInfo[] = []
    const sessionDir = join(tasksDir, sessionId)
    let sessionDirStat: Awaited<ReturnType<typeof stat>>
    try {
      sessionDirStat = await stat(sessionDir)
    } catch {
      return oldTaskFiles
    }
    if (!sessionDirStat.isDirectory()) return oldTaskFiles

    let files: string[] = []
    try {
      files = await readdir(sessionDir)
    } catch {
      return oldTaskFiles
    }

    for (const file of files) {
      const taskFile = await processTaskFile(sessionId, sessionDir, file, cutoffMs)
      if (taskFile) {
        oldTaskFiles.push(taskFile)
      }
    }
    return oldTaskFiles
  }

  for (const sessionId of sessionEntries) {
    if (allowedSessionIds && !allowedSessionIds.has(sessionId)) continue

    const sessionTasks = await processSessionDir(sessionId, tasksDir, cutoffMs)
    if (sessionTasks.length > 0) {
      oldTaskFiles.push(...sessionTasks)
    }
  }

  return oldTaskFiles
}

async function trashSession(
  session: SessionInfo
): Promise<{ succeeded: number; failed: number; taskRemoved: boolean }> {
  let sessionPartSucceeded = false
  let failed = 0
  if (session.paths.length === 0) {
    sessionPartSucceeded = true
  } else {
    for (const p of session.paths) {
      if (await trashDir(p)) sessionPartSucceeded = true
      else failed++
    }
  }
  const taskRemoved = !!(session.taskDirPath && (await trashDir(session.taskDirPath)))
  return { succeeded: sessionPartSucceeded ? 1 : 0, failed, taskRemoved }
}

function extractSessionId(entry: string, isDirectory: boolean): string | undefined {
  if (isDirectory && UUID_RE.test(entry)) return entry
  if (!isDirectory && entry.endsWith(".jsonl")) {
    const id = entry.slice(0, -6)
    if (UUID_RE.test(id)) return id
  }
  return undefined
}

async function buildSessionMap(
  projectDir: string,
  entries: string[]
): Promise<Map<string, { paths: string[]; mtime: number; size: number }>> {
  const sessionMap = new Map<string, { paths: string[]; mtime: number; size: number }>()
  for (const entry of entries) {
    const p = join(projectDir, entry)
    let s: Awaited<ReturnType<typeof stat>>
    try {
      s = await stat(p)
    } catch {
      continue
    }
    const isDirectory = s.isDirectory()
    const sessionId = extractSessionId(entry, isDirectory)
    if (!sessionId) continue
    const existing = sessionMap.get(sessionId) ?? { paths: [], mtime: 0, size: 0 }
    existing.paths.push(p)
    existing.mtime = Math.max(existing.mtime, s.mtimeMs)
    existing.size += isDirectory ? await dirSize(p) : s.size
    sessionMap.set(sessionId, existing)
  }
  return sessionMap
}

async function resolveTaskDirInfo(
  tasksDir: string,
  sessionId: string
): Promise<{ taskDirPath: string | null; taskDirSizeBytes: number }> {
  const taskDirPath = join(tasksDir, sessionId)
  try {
    const tStat = await stat(taskDirPath)
    if (tStat.isDirectory()) {
      return { taskDirPath, taskDirSizeBytes: await dirSize(taskDirPath) }
    }
  } catch {
    // No matching task directory — that's fine
  }
  return { taskDirPath: null, taskDirSizeBytes: 0 }
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

  const sessionMap = await buildSessionMap(projectDir, entries)

  for (const [sessionId, data] of sessionMap) {
    const { taskDirPath, taskDirSizeBytes } = await resolveTaskDirInfo(tasksDir, sessionId)
    const info: SessionInfo = {
      sessionId,
      paths: data.paths,
      mtimeMs: data.mtime,
      sizeBytes: data.size,
      taskDirPath,
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

interface CleanupFlagState {
  olderThan: { ms: number; label: string }
  taskOlderThan: { ms: number; label: string } | null
  dryRun: boolean
  projectFilter: string | undefined
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
  }
}

// ─── Run helpers ─────────────────────────────────────────────────────────────

interface ProjectResult {
  name: string
  keep: SessionInfo[]
  old: SessionInfo[]
  stale: boolean
}

async function discoverProjectNames(
  projectsDir: string,
  projectFilter: string | undefined
): Promise<string[] | null> {
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
    return null
  }
  if (projectFilter && projectNames.length === 0) {
    throw new Error(`Project "${projectFilter}" not found in ${projectsDir}`)
  }
  return projectNames
}

async function scanProjects(
  projectNames: string[],
  projectsDir: string,
  cutoffMs: number,
  tasksDir: string
): Promise<ProjectResult[]> {
  const results: ProjectResult[] = []
  for (const name of projectNames) {
    const { keep, old } = await findSessions(join(projectsDir, name), cutoffMs, tasksDir)
    if (keep.length > 0 || old.length > 0) {
      results.push({ name, keep, old, stale: false })
    }
  }
  return results
}

async function markStaleProjects(results: ProjectResult[]): Promise<void> {
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
}

function collectSessionIds(results: ProjectResult[]): Set<string> {
  const ids = new Set<string>()
  for (const result of results) {
    for (const session of result.keep) ids.add(session.sessionId)
    for (const session of result.old) ids.add(session.sessionId)
  }
  return ids
}

async function appendOrphanTasks(
  results: ProjectResult[],
  tasksDir: string,
  cutoffMs: number
): Promise<void> {
  const allKnownSessionIds = collectSessionIds(results)
  let taskEntries: string[] = []
  try {
    taskEntries = await readdir(tasksDir)
  } catch {}

  const orphans: SessionInfo[] = []
  for (const entry of taskEntries) {
    if (!UUID_RE.test(entry) || allKnownSessionIds.has(entry)) continue
    const taskDirPath = join(tasksDir, entry)
    try {
      const s = await stat(taskDirPath)
      if (!s.isDirectory()) continue
      orphans.push({
        sessionId: entry,
        paths: [],
        mtimeMs: s.mtimeMs,
        sizeBytes: 0,
        taskDirPath,
        taskDirSizeBytes: await dirSize(taskDirPath),
      })
    } catch {
      /* skip unreadable task directories */
    }
  }

  if (orphans.length > 0) {
    const { keep, old } = partitionByCutoff(orphans, cutoffMs)
    if (keep.length > 0 || old.length > 0) {
      results.push({ name: "(orphaned tasks)", keep, old, stale: true })
    }
  }
}

interface BackupInfo {
  fileCount: number
  sizeBytes: number
  files: string[]
}

interface CleanupTotals {
  totalOldCount: number
  totalOldBytes: number
  totalOldTaskDirs: number
  totalBytes: number
  nothingToTrash: boolean
}

function printBackupSection(label: string, backups: BackupInfo): void {
  if (backups.fileCount === 0) return
  console.log(`  ${BOLD}~/.${label.toLowerCase()}/ (backup artifacts)${RESET}`)
  console.log(
    `    ${YELLOW}${backups.fileCount} backup ${backups.fileCount === 1 ? "file" : "files"}${RESET} (${formatBytes(backups.sizeBytes)})`
  )
  console.log()
}

interface CleanupReportOpts {
  results: ProjectResult[]
  claudeBackups: BackupInfo
  geminiBackups: BackupInfo
  oldTaskFiles: Array<{ path: string; sizeBytes: number }>
  oldTaskBytes: number
  taskCutoffMs: number | null
  cleanupArgs: CleanupArgs
}

interface ProjectTotals {
  totalOldCount: number
  totalOldBytes: number
  totalOldTaskDirs: number
}

async function printProjectTable(results: ProjectResult[]): Promise<ProjectTotals> {
  const decodedNames = await Promise.all(
    results.map((r) => (r.name.startsWith("(") ? r.name : decodeProjectPath(r.name)))
  )
  const maxNameLen = Math.max(...decodedNames.map((n) => n.length), 20)

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

  return { totalOldCount, totalOldBytes, totalOldTaskDirs }
}

function printTaskSection(
  oldTaskFiles: Array<{ path: string; sizeBytes: number }>,
  oldTaskBytes: number,
  taskLabel: string
): void {
  console.log(`  ${BOLD}~/.claude/tasks/ (old task files)${RESET}`)
  const taskCountLabel = oldTaskFiles.length === 1 ? "file" : "files"
  const taskPart =
    oldTaskFiles.length > 0
      ? `${YELLOW}${oldTaskFiles.length} task ${taskCountLabel}${RESET} (${formatBytes(oldTaskBytes)})`
      : `${DIM}0 task files${RESET}`
  console.log(`    ${taskPart} older than ${taskLabel}`)
  console.log()
}

function buildTotalSummaryLine(
  totals: ProjectTotals,
  oldTaskFiles: Array<{ path: string; sizeBytes: number }>,
  claudeBackups: BackupInfo,
  geminiBackups: BackupInfo,
  totalBytes: number
): string {
  const taskSuffix =
    totals.totalOldTaskDirs > 0
      ? ` + ${totals.totalOldTaskDirs} task ${totals.totalOldTaskDirs === 1 ? "dir" : "dirs"}`
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
  return (
    `  Total: ${BOLD}${totals.totalOldCount} sessions${RESET}` +
    `${taskSuffix}${oldTaskPart}${claudePart}${geminiPart}` +
    ` trashable, ~${formatBytes(totalBytes)}`
  )
}

async function printCleanupReport(opts: CleanupReportOpts): Promise<CleanupTotals> {
  const {
    results,
    claudeBackups,
    geminiBackups,
    oldTaskFiles,
    oldTaskBytes,
    taskCutoffMs,
    cleanupArgs,
  } = opts

  const totals = await printProjectTable(results)

  console.log()
  printBackupSection("claude", claudeBackups)
  printBackupSection("gemini", geminiBackups)

  if (taskCutoffMs !== null) {
    const taskLabel = cleanupArgs.taskOlderThanLabel ?? "specified window"
    printTaskSection(oldTaskFiles, oldTaskBytes, taskLabel)
  }

  const totalBytes =
    totals.totalOldBytes + oldTaskBytes + claudeBackups.sizeBytes + geminiBackups.sizeBytes
  const nothingToTrash =
    totals.totalOldCount === 0 &&
    oldTaskFiles.length === 0 &&
    claudeBackups.fileCount === 0 &&
    geminiBackups.fileCount === 0

  if (nothingToTrash) {
    console.log(
      `  ${GREEN}No sessions older than ${cleanupArgs.olderThanLabel}, no old task files, and no Claude or Gemini backups found.${RESET}`
    )
    return { ...totals, totalBytes, nothingToTrash: true }
  }

  console.log(buildTotalSummaryLine(totals, oldTaskFiles, claudeBackups, geminiBackups, totalBytes))
  console.log()

  return { ...totals, totalBytes, nothingToTrash: false }
}

async function trashFileList(files: string[]): Promise<{ removed: number; failed: number }> {
  let removed = 0
  let failed = 0
  for (const file of files) {
    if (await trashDir(file)) removed++
    else failed++
  }
  return { removed, failed }
}

interface ExecuteCleanupOpts {
  results: ProjectResult[]
  claudeBackups: BackupInfo
  geminiBackups: BackupInfo
  oldTaskFiles: Array<{ path: string; sizeBytes: number }>
  totalOldCount: number
  totalOldTaskDirs: number
  totalBytes: number
}

function buildCleanupSuffix(opts: ExecuteCleanupOpts): string {
  const taskSuffix =
    opts.totalOldTaskDirs > 0
      ? ` + ${opts.totalOldTaskDirs} task ${opts.totalOldTaskDirs === 1 ? "dir" : "dirs"}`
      : ""
  const claudePart =
    opts.claudeBackups.fileCount > 0
      ? ` + ${opts.claudeBackups.fileCount} ${backupLabel("Claude", opts.claudeBackups.fileCount)}`
      : ""
  const geminiPart =
    opts.geminiBackups.fileCount > 0
      ? ` + ${opts.geminiBackups.fileCount} ${backupLabel("Gemini", opts.geminiBackups.fileCount)}`
      : ""
  const oldTaskPart =
    opts.oldTaskFiles.length > 0 ? ` + ${opts.oldTaskFiles.length} old task files` : ""
  return `${taskSuffix}${oldTaskPart}${claudePart}${geminiPart}`
}

async function trashAllSessions(
  results: ProjectResult[]
): Promise<{ succeeded: number; failed: number; taskDirsRemoved: number }> {
  let succeeded = 0
  let failed = 0
  let taskDirsRemoved = 0
  for (const { old } of results) {
    for (const session of old) {
      const r = await trashSession(session)
      succeeded += r.succeeded
      failed += r.failed
      if (r.taskRemoved) taskDirsRemoved++
    }
  }
  return { succeeded, failed, taskDirsRemoved }
}

function printCleanupResult(
  sessions: { succeeded: number; failed: number; taskDirsRemoved: number },
  tasks: { removed: number; failed: number },
  claude: { removed: number; failed: number },
  gemini: { removed: number; failed: number },
  totalBytes: number
): void {
  const taskDirNote =
    sessions.taskDirsRemoved > 0 ? ` + ${sessions.taskDirsRemoved} task dir(s)` : ""
  const claudeNote =
    claude.removed > 0 ? ` + ${claude.removed} ${backupLabel("Claude", claude.removed)}` : ""
  const geminiNote =
    gemini.removed > 0 ? ` + ${gemini.removed} ${backupLabel("Gemini", gemini.removed)}` : ""
  const oldTaskNote =
    tasks.removed > 0
      ? ` + ${tasks.removed} old task ${tasks.removed === 1 ? "file" : "files"}`
      : ""
  console.log(
    `  ${GREEN}${BOLD}Done.${RESET} ${sessions.succeeded} session(s)` +
      `${taskDirNote}${oldTaskNote}${claudeNote}${geminiNote}` +
      ` moved to Trash (~${formatBytes(totalBytes)} reclaimed).`
  )

  const totalFailed = sessions.failed + tasks.failed + claude.failed + gemini.failed
  if (totalFailed > 0) {
    const parts = [
      sessions.failed > 0 ? `${sessions.failed} session(s)` : "",
      tasks.failed > 0 ? `${tasks.failed} old task ${tasks.failed === 1 ? "file" : "files"}` : "",
      claude.failed > 0 ? `${claude.failed} ${backupLabel("Claude", claude.failed)}` : "",
      gemini.failed > 0 ? `${gemini.failed} ${backupLabel("Gemini", gemini.failed)}` : "",
    ]
      .filter((s) => s)
      .join(" + ")
    console.log(
      `  ${YELLOW}${parts} could not be trashed — is the \`trash\` CLI installed?${RESET}`
    )
  }
}

async function executeCleanup(opts: ExecuteCleanupOpts): Promise<void> {
  const daemonStopState = await stopDaemonForCleanup()
  if (daemonStopState === "stopped") {
    console.log(`  ${DIM}Stopped ${DAEMON_LABEL} before cleanup.${RESET}`)
  } else if (daemonStopState === "failed") {
    console.log(`  ${YELLOW}Warning: failed to stop ${DAEMON_LABEL}; continuing cleanup.${RESET}`)
  }

  const suffix = buildCleanupSuffix(opts)
  try {
    console.log(`  Moving ${opts.totalOldCount} session(s)${suffix} to Trash...`)
    const sessions = await trashAllSessions(opts.results)
    const claude = await trashFileList(opts.claudeBackups.files)
    const gemini = await trashFileList(opts.geminiBackups.files)
    const tasks = await trashFileList(opts.oldTaskFiles.map((t) => t.path))

    console.log()
    printCleanupResult(sessions, tasks, claude, gemini, opts.totalBytes)
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
    const cleanupArgs = parseCleanupArgs(args)
    const { projectsDir, tasksDir } = createDefaultTaskStore()
    const cutoffMs = Date.now() - cleanupArgs.olderThanMs
    const taskCutoffMs = cleanupArgs.taskOlderThanMs
      ? Date.now() - cleanupArgs.taskOlderThanMs
      : null

    const projectNames = await discoverProjectNames(projectsDir, cleanupArgs.projectFilter)
    if (!projectNames) return

    const results = await scanProjects(projectNames, projectsDir, cutoffMs, tasksDir)
    await markStaleProjects(results)

    const scopedSessionIds = collectSessionIds(results)
    const oldTaskFiles =
      taskCutoffMs === null
        ? []
        : await findOldTaskFiles(
            tasksDir,
            taskCutoffMs,
            cleanupArgs.projectFilter ? scopedSessionIds : undefined
          )
    const oldTaskBytes = oldTaskFiles.reduce((sum, task) => sum + task.sizeBytes, 0)

    if (!cleanupArgs.projectFilter) {
      await appendOrphanTasks(results, tasksDir, cutoffMs)
    }

    const [claudeBackups, geminiBackups] = await Promise.all([
      findClaudeBackups(),
      findGeminiBackups(),
    ])

    if (results.length === 0 && claudeBackups.fileCount === 0 && geminiBackups.fileCount === 0) {
      console.log(`No session directories found (older than ${cleanupArgs.olderThanLabel}).`)
      console.log(`No Claude or Gemini backup artifacts found.`)
      return
    }

    const totals = await printCleanupReport({
      results,
      claudeBackups,
      geminiBackups,
      oldTaskFiles,
      oldTaskBytes,
      taskCutoffMs,
      cleanupArgs,
    })

    if (totals.nothingToTrash) return
    if (cleanupArgs.dryRun) {
      console.log(`  ${DIM}Run without --dry-run to proceed.${RESET}`)
      return
    }

    await executeCleanup({
      results,
      claudeBackups,
      geminiBackups,
      oldTaskFiles,
      totalOldCount: totals.totalOldCount,
      totalOldTaskDirs: totals.totalOldTaskDirs,
      totalBytes: totals.totalBytes,
    })
  },
}
