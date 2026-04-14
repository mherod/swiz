/**
 * Cleanup-only session retention and artifact pruning for `swiz doctor clean`.
 * This module owns cleanup discovery, reporting, and deletion so doctor.ts can
 * stay focused on diagnostics and command routing.
 */
import type { Stats } from "node:fs"
import { cp, readdir, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { BOLD, DIM, GREEN, RESET, YELLOW } from "../../ansi.ts"
import { debugLog } from "../../debug.ts"
import { getHomeDir } from "../../home.ts"
import {
  getLaunchAgentPlistPath,
  loadLaunchAgent,
  SWIZ_DAEMON_LABEL,
  unloadLaunchAgent,
} from "../../launch-agents.ts"
import { projectKeyFromCwd } from "../../project-key.ts"
import { defaultTrashPath } from "../../session-data-delete.ts"
import { createDefaultTaskStore } from "../../task-roots.ts"
import { isSessionTaskJsonFile } from "../../tasks/task-file-utils.ts"
import { formatBytes } from "../../utils/format.ts"
import { getDaemonStatus } from "../daemon/daemon-admin.ts"
import {
  type CleanupArgs,
  decodeProjectPath,
  parseCleanupArgs,
  parseOlderThan,
  walkDecode,
} from "./cleanup-path.ts"

const CLEANUP_HOME = getHomeDir()
const DAEMON_LABEL = SWIZ_DAEMON_LABEL

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ORPHAN_SESSION_ID_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|test-.*|unknown-.*)$/i

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

const trashDir = defaultTrashPath

async function hardDelete(path: string): Promise<boolean> {
  try {
    await rm(path, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

type DaemonStopState = "not-installed" | "not-running" | "stopped" | "failed"

async function stopDaemonForCleanup(): Promise<DaemonStopState> {
  const status = await getDaemonStatus()
  if (!status.installed) return "not-installed"
  if (!status.loaded) return "not-running"
  const plistPath = getLaunchAgentPlistPath(DAEMON_LABEL)
  return (await unloadLaunchAgent(plistPath)) === 0 ? "stopped" : "failed"
}

async function restartDaemonAfterCleanup(): Promise<boolean> {
  const status = await getDaemonStatus()
  if (!status.installed) return false
  return (await loadLaunchAgent(getLaunchAgentPlistPath(DAEMON_LABEL))) === 0
}

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

async function findClaudeBackups(claudeDir: string): Promise<ClaudeBackupInfo> {
  const backup: ClaudeBackupInfo = { files: [], sizeBytes: 0, fileCount: 0 }

  try {
    const entries = await readdir(claudeDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const name = entry.name
      if (name === "settings.json.backup" || name.startsWith("settings.json.bak")) {
        await addBackupFile(join(claudeDir, name), backup)
      }
    }
  } catch {
    // claudeDir doesn't exist or is unreadable
  }

  return backup
}

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

async function findGeminiBackups(homeDir: string): Promise<GeminiBackupInfo> {
  const geminiDir = join(homeDir, ".gemini")
  const geminiSettingsBak = join(geminiDir, "settings.json.bak")
  const geminiTmpDir = join(geminiDir, "tmp")
  const backup: GeminiBackupInfo = { files: [], sizeBytes: 0, fileCount: 0 }

  await addBackupFile(geminiSettingsBak, backup)
  await collectBakFiles(geminiTmpDir, backup, true)

  return backup
}

interface SessionInfo {
  sessionId: string
  paths: string[]
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

  type TaskFileBody = {
    id?: string
    status?: string
    statusChangedAt?: string
    completionTimestamp?: string
  }

  async function statTaskFileForScan(filePath: string): Promise<Stats | null> {
    try {
      const s = await stat(filePath)
      return s.isFile() ? s : null
    } catch {
      return null
    }
  }

  async function readTaskFileUtf8(filePath: string): Promise<string | null> {
    try {
      return await readFile(filePath, "utf-8")
    } catch {
      return null
    }
  }

  function parseTaskFileJson(raw: string): TaskFileBody | null {
    try {
      return JSON.parse(raw) as TaskFileBody
    } catch {
      return null
    }
  }

  function oldTaskFromStatOnly(
    sessionId: string,
    file: string,
    filePath: string,
    fileStat: Stats,
    cutoffMs: number,
    status: string
  ): OldTaskFileInfo | null {
    if (fileStat.mtimeMs >= cutoffMs) return null
    return {
      sessionId,
      taskId: file.slice(0, -5),
      status,
      path: filePath,
      sizeBytes: fileStat.size,
    }
  }

  async function processTaskFile(
    sessionId: string,
    sessionDir: string,
    file: string,
    cutoffMs: number
  ): Promise<OldTaskFileInfo | null> {
    if (!isSessionTaskJsonFile(file)) return null
    const filePath = join(sessionDir, file)
    const fileStat = await statTaskFileForScan(filePath)
    if (!fileStat) return null

    const raw = await readTaskFileUtf8(filePath)
    if (raw === null) {
      return oldTaskFromStatOnly(sessionId, file, filePath, fileStat, cutoffMs, "(read error)")
    }

    const task = parseTaskFileJson(raw)
    if (task === null) {
      return oldTaskFromStatOnly(sessionId, file, filePath, fileStat, cutoffMs, "(invalid json)")
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

export async function truncateJsonlFile(
  filePath: string,
  cutoffMs: number,
  skipBackup?: boolean
): Promise<number> {
  let raw: string
  try {
    raw = await readFile(filePath, "utf-8")
  } catch {
    return 0
  }
  if (!raw) return 0

  const lines = raw.split("\n")
  const kept: string[] = []
  let removed = 0

  for (const line of lines) {
    if (!line.trim()) {
      if (kept.length > 0) kept.push(line)
      continue
    }
    let ts: number | null = null
    try {
      const obj = JSON.parse(line) as { timestamp?: string }
      if (obj.timestamp) {
        const parsed = Date.parse(obj.timestamp)
        if (!Number.isNaN(parsed)) ts = parsed
      }
    } catch {
      // Unparseable line — keep it
    }
    if (ts !== null && ts < cutoffMs) {
      removed++
    } else {
      kept.push(line)
    }
  }

  if (removed === 0) return 0

  if (!skipBackup) {
    await cp(filePath, `${filePath}.bak`)
  }

  await Bun.write(filePath, kept.join("\n"))
  return removed
}

async function truncateKeptSessions(
  results: ProjectResult[],
  cutoffMs: number,
  skipBackup?: boolean
): Promise<{ filesAffected: number; linesRemoved: number }> {
  let filesAffected = 0
  let linesRemoved = 0

  for (const { keep } of results) {
    for (const session of keep) {
      for (const p of session.paths) {
        if (p.endsWith(".jsonl")) {
          const removed = await truncateJsonlFile(p, cutoffMs, skipBackup)
          if (removed > 0) {
            filesAffected++
            linesRemoved += removed
          }
        } else {
          let entries: string[]
          try {
            entries = await readdir(p)
          } catch {
            continue
          }
          for (const entry of entries) {
            if (!entry.endsWith(".jsonl")) continue
            const removed = await truncateJsonlFile(join(p, entry), cutoffMs)
            if (removed > 0) {
              filesAffected++
              linesRemoved += removed
            }
          }
        }
      }
    }
  }

  return { filesAffected, linesRemoved }
}

async function trashSession(
  session: SessionInfo,
  deleteFn: (path: string) => Promise<boolean> = trashDir
): Promise<{ succeeded: number; failed: number; taskRemoved: boolean }> {
  let sessionPartSucceeded = false
  let failed = 0
  if (session.paths.length === 0) {
    sessionPartSucceeded = true
  } else {
    for (const p of session.paths) {
      if (await deleteFn(p)) sessionPartSucceeded = true
      else failed++
    }
  }
  let taskRemoved = false
  if (session.taskDirPath) {
    if (await deleteFn(session.taskDirPath)) {
      taskRemoved = true
    } else {
      failed++
      if (session.paths.length === 0) sessionPartSucceeded = false
    }
  }
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
    return null
  }
  if (projectFilter && projectNames.length === 0) {
    return null
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
  const encodedHome = projectKeyFromCwd(CLEANUP_HOME)
  for (let i = 0; i < results.length; i++) {
    const name = results[i]!.name
    if (!name.startsWith(encodedHome)) continue
    const encodedRest = name.slice(encodedHome.length)
    if (!encodedRest) continue
    if ((await walkDecode(CLEANUP_HOME, encodedRest)) === null) {
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

async function getRealSessionMtime(taskDirPath: string): Promise<number | null> {
  let taskEntries: string[] = []
  try {
    taskEntries = await readdir(taskDirPath)
  } catch {
    return null
  }

  let maxMs = 0
  for (const file of taskEntries) {
    if (!isSessionTaskJsonFile(file)) continue
    const p = join(taskDirPath, file)
    let s: Stats
    try {
      s = await stat(p)
    } catch (err) {
      debugLog(`[doctor] stat failed for ${p}: ${(err as NodeJS.ErrnoException).code ?? err}`)
      continue
    }
    let taskMs = s.mtimeMs
    let raw: string
    try {
      raw = await readFile(p, "utf-8")
    } catch (err) {
      debugLog(`[doctor] readFile failed for ${p}: ${(err as NodeJS.ErrnoException).code ?? err}`)
      if (taskMs > maxMs) maxMs = taskMs
      continue
    }
    try {
      const taskJson = JSON.parse(raw) as {
        statusChangedAt?: string
        completionTimestamp?: string
      }
      const parsedMs = parseTaskAgeMs(taskJson)
      if (parsedMs !== null) taskMs = parsedMs
    } catch {
      // invalid JSON — stick to file mtime
    }
    if (taskMs > maxMs) maxMs = taskMs
  }
  return maxMs > 0 ? maxMs : null
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
    if (!ORPHAN_SESSION_ID_RE.test(entry) || allKnownSessionIds.has(entry)) continue
    const taskDirPath = join(tasksDir, entry)
    try {
      const s = await stat(taskDirPath)
      if (!s.isDirectory()) continue

      const realMtimeMs = (await getRealSessionMtime(taskDirPath)) ?? s.mtimeMs

      orphans.push({
        sessionId: entry,
        paths: [],
        mtimeMs: realMtimeMs,
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
    results.map((r) =>
      r.name.startsWith("(") || UUID_RE.test(r.name)
        ? Promise.resolve(r.name)
        : decodeProjectPath(r.name)
    )
  )
  const maxNameLen = Math.max(...decodedNames.map((n) => n.length), 20)

  console.log()
  console.log(`  ${BOLD}Agent Sessions${RESET}`)

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

async function trashFileList(
  files: string[],
  deleteFn: (path: string) => Promise<boolean> = trashDir
): Promise<{ removed: number; failed: number }> {
  let removed = 0
  let failed = 0
  for (const file of files) {
    if (await deleteFn(file)) removed++
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
  cutoffMs: number
  skipTrash?: boolean
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
  results: ProjectResult[],
  deleteFn: (path: string) => Promise<boolean> = trashDir
): Promise<{ succeeded: number; failed: number; taskDirsRemoved: number }> {
  let succeeded = 0
  let failed = 0
  let taskDirsRemoved = 0
  for (const { old } of results) {
    for (const session of old) {
      const r = await trashSession(session, deleteFn)
      succeeded += r.succeeded
      failed += r.failed
      if (r.taskRemoved) taskDirsRemoved++
    }
  }
  return { succeeded, failed, taskDirsRemoved }
}

function buildCleanupNotes(
  sessions: { taskDirsRemoved: number },
  tasks: { removed: number },
  claude: { removed: number },
  gemini: { removed: number }
): string {
  const parts: string[] = []
  if (sessions.taskDirsRemoved > 0) parts.push(`${sessions.taskDirsRemoved} task dir(s)`)
  if (tasks.removed > 0)
    parts.push(`${tasks.removed} old task ${tasks.removed === 1 ? "file" : "files"}`)
  if (claude.removed > 0) parts.push(`${claude.removed} ${backupLabel("Claude", claude.removed)}`)
  if (gemini.removed > 0) parts.push(`${gemini.removed} ${backupLabel("Gemini", gemini.removed)}`)
  return parts.length > 0 ? ` + ${parts.join(" + ")}` : ""
}

function printCleanupResult(
  sessions: { succeeded: number; failed: number; taskDirsRemoved: number },
  tasks: { removed: number; failed: number },
  claude: { removed: number; failed: number },
  gemini: { removed: number; failed: number },
  totalBytes: number,
  doneVerb = "moved to Trash"
): void {
  const notes = buildCleanupNotes(sessions, tasks, claude, gemini)
  console.log(
    `  ${GREEN}${BOLD}Done.${RESET} ${sessions.succeeded} session(s)${notes}` +
      ` ${doneVerb} (~${formatBytes(totalBytes)} reclaimed).`
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

  const deleteFn = opts.skipTrash ? hardDelete : trashDir
  const verb = opts.skipTrash ? "Deleting" : "Moving"
  const doneVerb = opts.skipTrash ? "deleted" : "moved to Trash"
  const suffix = buildCleanupSuffix(opts)
  try {
    console.log(`  ${verb} ${opts.totalOldCount} session(s)${suffix}...`)
    const sessions = await trashAllSessions(opts.results, deleteFn)
    const claude = await trashFileList(opts.claudeBackups.files, deleteFn)
    const gemini = await trashFileList(opts.geminiBackups.files, deleteFn)
    const tasks = await trashFileList(
      opts.oldTaskFiles.map((t) => t.path),
      deleteFn
    )

    const truncation = await truncateKeptSessions(opts.results, opts.cutoffMs, opts.skipTrash)
    if (truncation.linesRemoved > 0) {
      console.log(
        `  ${DIM}Truncated ${truncation.linesRemoved} old line(s) from ${truncation.filesAffected} transcript(s).${RESET}`
      )
    }

    console.log()
    printCleanupResult(sessions, tasks, claude, gemini, opts.totalBytes, doneVerb)
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

export async function autoCleanup(): Promise<void> {
  const cleanupArgs = {
    olderThanMs: parseOlderThan("1").ms,
    olderThanLabel: "1 day",
    taskOlderThanMs: null,
    taskOlderThanLabel: null,
    dryRun: false,
    projectFilter: undefined,
  }

  const data = await gatherCleanupData(cleanupArgs)
  const { results, claudeBackups, geminiBackups, oldTaskFiles, oldTaskBytes } = data

  const totals = {
    totalOldCount: 0,
    totalOldBytes: 0,
    totalOldTaskDirs: 0,
    totalBytes: 0,
  }

  for (const { old } of results) {
    totals.totalOldCount += old.length
    totals.totalOldBytes += old.reduce((sum, s) => sum + s.sizeBytes, 0)
    totals.totalOldTaskDirs += old.filter((s) => s.taskDirPath !== null).length
  }

  const totalBytes =
    totals.totalOldBytes + oldTaskBytes + claudeBackups.sizeBytes + geminiBackups.sizeBytes
  const nothingToTrash =
    totals.totalOldCount === 0 &&
    oldTaskFiles.length === 0 &&
    claudeBackups.fileCount === 0 &&
    geminiBackups.fileCount === 0

  const cutoffMs = Date.now() - cleanupArgs.olderThanMs
  const hasKeptSessions = results.some(({ keep }) => keep.length > 0)
  if (nothingToTrash) {
    if (hasKeptSessions) {
      await truncateKeptSessions(results, cutoffMs)
    }
    return
  }

  console.log(`\n  ${BOLD}Cleaning up old session data (> 24h)...${RESET}`)
  await executeCleanup({
    results,
    claudeBackups,
    geminiBackups,
    oldTaskFiles,
    totalOldCount: totals.totalOldCount,
    totalOldTaskDirs: totals.totalOldTaskDirs,
    totalBytes,
    cutoffMs,
  })
}

async function gatherCleanupData(cleanupArgs: CleanupArgs) {
  const homeDir = getHomeDir()
  const claudeDir = join(homeDir, ".claude")
  const projectsDir = join(claudeDir, "projects")
  const tasksDir = join(claudeDir, "tasks")

  const cutoffMs = Date.now() - cleanupArgs.olderThanMs
  const taskCutoffMs = cleanupArgs.taskOlderThanMs ? Date.now() - cleanupArgs.taskOlderThanMs : null

  let results: ProjectResult[] = []

  const projectNames = await discoverProjectNames(projectsDir, cleanupArgs.projectFilter)
  if (projectNames) {
    const claudeResults = await scanProjects(projectNames, projectsDir, cutoffMs, tasksDir)
    await markStaleProjects(claudeResults)
    results = results.concat(claudeResults)
  }

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
    findClaudeBackups(claudeDir),
    findGeminiBackups(homeDir),
  ])
  return { results, oldTaskFiles, oldTaskBytes, taskCutoffMs, claudeBackups, geminiBackups }
}

export async function runCleanupCommand(args: string[]): Promise<void> {
  const cleanupArgs = parseCleanupArgs(args)
  const data = await gatherCleanupData(cleanupArgs)
  const { results, claudeBackups, geminiBackups, oldTaskFiles, oldTaskBytes, taskCutoffMs } = data

  if (results.length === 0 && claudeBackups.fileCount === 0 && geminiBackups.fileCount === 0) {
    if (!cleanupArgs.projectFilter) {
      console.log(`No session directories found (older than ${cleanupArgs.olderThanLabel}).`)
      console.log(`No Claude or Gemini backup artifacts found.`)
    }
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

  const cutoffMs = Date.now() - cleanupArgs.olderThanMs

  if (totals.nothingToTrash && cleanupArgs.dryRun) return
  if (totals.nothingToTrash) {
    const truncation = await truncateKeptSessions(results, cutoffMs, cleanupArgs.skipTrash)
    if (truncation.linesRemoved > 0) {
      console.log(
        `  ${DIM}Truncated ${truncation.linesRemoved} old line(s) from ${truncation.filesAffected} transcript(s).${RESET}`
      )
    }
    return
  }
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
    cutoffMs,
    skipTrash: cleanupArgs.skipTrash,
  })
}
