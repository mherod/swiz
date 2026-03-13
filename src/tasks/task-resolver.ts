/**
 * Task resolution layer — session discovery and cross-session task lookup.
 * Uses session-meta index for O(1) cwd matching and open-task-count checks.
 * Owns: getSessionIdsForProject, getSessionIdsByCwdScan, getSessions,
 *       findTaskAcrossSessions, resolveTaskById, and hint builders.
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { DIM, RESET } from "../ansi.ts"
import { debugLog } from "../debug.ts"
import { projectKeyFromCwd } from "../project-key.ts"
import { createDefaultTaskStore } from "../task-roots.ts"
import {
  compareTaskIds,
  parseTaskId,
  readSessionMeta,
  readTasks,
  sessionPrefix,
  type Task,
} from "./task-repository.ts"

export type { Task }

// ─── Session discovery ───────────────────────────────────────────────────────

/** Derive session IDs from a single project transcript directory (constant-time lookup). */
export async function getSessionIdsForProject(
  projectKey: string,
  projectsDir = createDefaultTaskStore().projectsDir
): Promise<Set<string>> {
  const projectDir = join(projectsDir, projectKey)
  const ids = new Set<string>()
  try {
    const files = await readdir(projectDir)
    for (const f of files) {
      if (f.endsWith(".jsonl")) ids.add(f.slice(0, -6))
    }
  } catch {}
  return ids
}

/** Collect all session IDs referenced by any project transcript directory. */
async function getAllProjectSessionIds(
  projectsDir = createDefaultTaskStore().projectsDir
): Promise<Set<string>> {
  const ids = new Set<string>()
  let projectDirs: string[]
  try {
    projectDirs = await readdir(projectsDir)
  } catch {
    return ids
  }
  for (const projectDir of projectDirs) {
    let files: string[]
    try {
      files = await readdir(join(projectsDir, projectDir))
    } catch {
      continue
    }
    for (const f of files) {
      if (f.endsWith(".jsonl")) ids.add(f.slice(0, -6))
    }
  }
  return ids
}

/** Check if a transcript file's first 10 lines contain a matching cwd field. */
async function transcriptMatchesCwd(filePath: string, filterCwd: string): Promise<boolean> {
  try {
    const content = await readFile(filePath, "utf-8")
    for (const line of content.split("\n").slice(0, 10)) {
      if (!line.trim()) continue
      try {
        const data = JSON.parse(line) as { cwd?: string }
        if (data.cwd === filterCwd) return true
      } catch {}
    }
  } catch {}
  return false
}

/** Partition candidates into matched (meta cwd matches) and remaining (no meta cwd). */
async function partitionByMeta(
  candidates: string[],
  filterCwd: string,
  tasksDir: string
): Promise<{ matched: Set<string>; remaining: string[] }> {
  const matched = new Set<string>()
  const remaining: string[] = []
  for (const sessionId of candidates) {
    const meta = await readSessionMeta(sessionId, tasksDir)
    if (meta?.cwd === filterCwd) {
      matched.add(sessionId)
    } else if (!meta?.cwd) {
      remaining.push(sessionId)
    }
  }
  return { matched, remaining }
}

/** Scan transcript directories for sessions matching filterCwd. */
async function scanTranscriptsForCwd(
  remaining: Set<string>,
  filterCwd: string,
  projectsDir: string,
  ids: Set<string>
): Promise<void> {
  let dirs: string[]
  try {
    dirs = await readdir(projectsDir)
  } catch {
    return
  }
  for (const dir of dirs) {
    if (remaining.size === 0) break
    let files: string[]
    try {
      files = await readdir(join(projectsDir, dir))
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue
      const sessionId = f.slice(0, -6)
      if (!remaining.has(sessionId)) continue
      if (await transcriptMatchesCwd(join(projectsDir, dir, f), filterCwd)) {
        ids.add(sessionId)
        remaining.delete(sessionId)
      }
    }
  }
}

/**
 * Fallback: resolve sessions whose cwd matches filterCwd.
 * Fast path: check .session-meta.json cwd field first (O(candidates)).
 * Slow path: only for candidates without meta, scan transcript directories.
 */
export async function getSessionIdsByCwdScan(
  filterCwd: string,
  candidates: string[],
  projectsDir = createDefaultTaskStore().projectsDir,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<Set<string>> {
  const { matched: ids, remaining } = await partitionByMeta(candidates, filterCwd, tasksDir)
  if (remaining.length === 0) return ids
  await scanTranscriptsForCwd(new Set(remaining), filterCwd, projectsDir, ids)
  return ids
}

export async function getSessions(
  filterCwd?: string,
  tasksDir = createDefaultTaskStore().tasksDir,
  projectsDir = createDefaultTaskStore().projectsDir
): Promise<string[]> {
  try {
    const entries = await readdir(tasksDir)

    let matchedSessionIds: Set<string> | null = null

    if (filterCwd) {
      // Fast path: derive project key directly and intersect with task sessions.
      const projectSessionIds = await getSessionIdsForProject(
        projectKeyFromCwd(filterCwd),
        projectsDir
      )
      matchedSessionIds = new Set<string>()
      for (const s of entries) {
        if (projectSessionIds.has(s)) matchedSessionIds.add(s)
      }

      // Fallback: scan transcript cwd values for any task entries NOT already
      // matched by the fast path. This catches sessions under older or
      // mismatched project-key encodings, even when the fast path found some.
      const unmatched = entries.filter((s) => !matchedSessionIds!.has(s))
      if (unmatched.length > 0) {
        const fallbackIds = await getSessionIdsByCwdScan(
          filterCwd,
          unmatched,
          projectsDir,
          tasksDir
        )
        for (const id of fallbackIds) matchedSessionIds.add(id)
      }

      // Compaction gap: include task-dir sessions that have no transcript in
      // ANY project directory yet. These are created by TaskCreate immediately
      // when a session starts, before the transcript file is written. Without
      // this, a freshly-compacted session is invisible to `swiz tasks` even
      // though its task files exist — the only session the agent can interact
      // with. Include them alongside matched sessions; mtime sort ensures they
      // surface at the top when they are the most recently active session.
      const allProjectSessionIds = await getAllProjectSessionIds(projectsDir)
      for (const s of entries) {
        if (!allProjectSessionIds.has(s)) matchedSessionIds.add(s)
      }
    }

    const stats = await Promise.all(
      entries
        .filter((s) => !matchedSessionIds || matchedSessionIds.has(s))
        .map(async (s) => {
          const p = join(tasksDir, s)
          const st = await stat(p)
          return { session: s, mtime: st.mtime }
        })
    )
    stats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    return stats.map((s) => s.session)
  } catch {
    return []
  }
}

// ─── Hint builders ───────────────────────────────────────────────────────────

/**
 * Build a hint string listing the 5 most recently created tasks in a session.
 * Appended to "task not found" errors so agents can quickly identify the right ID.
 */
export async function buildRecentTasksHint(
  sessionId: string,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<string> {
  try {
    const tasks = await readTasks(sessionId, tasksDir)
    if (tasks.length === 0) return ""
    const recent = tasks.slice(-5)
    const lines = recent.map((t) => `  #${t.id} [${t.status}]: ${t.subject}`).join("\n")
    return `\nRecent tasks in this session:\n${lines}`
  } catch {
    return ""
  }
}

/**
 * Build a hint listing the most recent sessions with a sample of task subjects
 * from each. Used in "no session found" errors so agents can spot the right
 * session without needing to run `swiz tasks`.
 */
export async function buildRecentSessionsHint(
  sessions: string[],
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<string> {
  if (sessions.length === 0) return ""
  const recent = sessions.slice(0, 5)
  const lines = await Promise.all(
    recent.map(async (sessionId) => {
      try {
        const tasks = await readTasks(sessionId, tasksDir)
        const preview = tasks
          .slice(-3)
          .map((t) => `    #${t.id} [${t.status}]: ${t.subject}`)
          .join("\n")
        return `  ${sessionId.slice(0, 8)}...${preview ? `\n${preview}` : " (no tasks)"}`
      } catch {
        return `  ${sessionId.slice(0, 8)}... (unreadable)`
      }
    })
  )
  return `\nRecent sessions:\n${lines.join("\n")}`
}

// ─── Cross-session task lookup ───────────────────────────────────────────────

/**
 * Search for a task by ID across all sessions for the current project.
 * Returns all matches (session + task pairs). Callers must handle the
 * case where multiple sessions contain the same task ID.
 */
export async function findTaskAcrossSessions(
  taskId: string,
  filterCwd?: string,
  tasksDir = createDefaultTaskStore().tasksDir,
  projectsDir = createDefaultTaskStore().projectsDir
): Promise<{ sessionId: string; task: Task }[]> {
  const sessions = await getSessions(filterCwd, tasksDir, projectsDir)
  const matches: { sessionId: string; task: Task }[] = []
  for (const sessionId of sessions) {
    const tasks = await readTasks(sessionId, tasksDir)
    const task = tasks.find((t) => t.id === taskId)
    if (task) matches.push({ sessionId, task })
  }
  return matches
}

/** List task-dir entries, returning [] on failure. */
async function safeReadTaskDirEntries(tasksDir: string): Promise<string[]> {
  try {
    return await readdir(tasksDir)
  } catch {
    return []
  }
}

/** Search orphan sessions (no transcript in any project dir) for a task matching the given prefix+ID. */
async function findInOrphanByPrefix(
  taskId: string,
  prefix: string,
  filterCwd: string | undefined,
  tasksDir: string,
  projectsDir: string
): Promise<{ sessionId: string; task: Task } | null> {
  if (!filterCwd) return null
  const allIndexedIds = await getAllProjectSessionIds(projectsDir)
  const taskDirEntries = await safeReadTaskDirEntries(tasksDir)
  const orphanSession = taskDirEntries.find(
    (s) => !allIndexedIds.has(s) && sessionPrefix(s) === prefix
  )
  if (!orphanSession) return null
  const tasks = await readTasks(orphanSession, tasksDir)
  const task = tasks.find((t) => t.id === taskId)
  if (!task) return null
  debugLog(
    `  ${DIM}Task #${taskId} resolved via compaction-recovery fallback in orphan session ${orphanSession.slice(0, 8)}...${RESET}`
  )
  return { sessionId: orphanSession, task }
}

/** Resolve a prefixed task ID by matching the prefix to a session. */
async function resolvePrefixedTaskId(opts: {
  taskId: string
  prefix: string
  primarySessionId: string
  filterCwd: string | undefined
  tasksDir: string
  projectsDir: string
}): Promise<{ sessionId: string; task: Task }> {
  const { taskId, prefix, primarySessionId, filterCwd, tasksDir, projectsDir } = opts
  if (sessionPrefix(primarySessionId) === prefix) {
    const tasks = await readTasks(primarySessionId, tasksDir)
    const task = tasks.find((t) => t.id === taskId)
    if (task) return { sessionId: primarySessionId, task }
  }

  const sessions = await getSessions(filterCwd, tasksDir, projectsDir)
  const matchingSession = sessions.find((s) => sessionPrefix(s) === prefix)
  if (matchingSession) {
    const tasks = await readTasks(matchingSession, tasksDir)
    const task = tasks.find((t) => t.id === taskId)
    if (task) {
      if (matchingSession !== primarySessionId) {
        debugLog(
          `  ${DIM}Task #${taskId} resolved via prefix to session ${matchingSession.slice(0, 8)}...${RESET}`
        )
      }
      return { sessionId: matchingSession, task }
    }
    const recentHint = await buildRecentTasksHint(matchingSession, tasksDir)
    throw new Error(
      `Task #${taskId} not found in session ${matchingSession.slice(0, 8)}... (prefix "${prefix}" matched but task file is missing).` +
        `\nUse --session ${matchingSession.slice(0, 8)} with a different task ID, or recreate the task.${recentHint}`
    )
  }

  const orphanResult = await findInOrphanByPrefix(taskId, prefix, filterCwd, tasksDir, projectsDir)
  if (orphanResult) return orphanResult

  const sessionsHint = await buildRecentSessionsHint(sessions, tasksDir)
  throw new Error(
    `Task #${taskId} not found (no session with prefix "${prefix}" exists in this project).${sessionsHint}`
  )
}

/** Search orphan sessions for an unprefixed task ID. */
async function findInOrphanUnprefixed(
  taskId: string,
  filterCwd: string | undefined,
  tasksDir: string,
  projectsDir: string
): Promise<{ sessionId: string; task: Task }[]> {
  if (!filterCwd) return []
  const allIndexedIds = await getAllProjectSessionIds(projectsDir)
  const taskDirEntries = await safeReadTaskDirEntries(tasksDir)
  for (const s of taskDirEntries) {
    if (allIndexedIds.has(s)) continue
    const tasks = await readTasks(s, tasksDir)
    const task = tasks.find((t) => t.id === taskId)
    if (task) {
      debugLog(
        `  ${DIM}Task #${taskId} found via compaction-recovery fallback in orphan session ${s.slice(0, 8)}...${RESET}`
      )
      return [{ sessionId: s, task }]
    }
  }
  return []
}

/**
 * Centralized task-by-ID resolution. Checks the primary session first,
 * then falls back to scanning all project sessions. Every command that
 * operates on a task by ID must use this single entry point.
 */
function handleMultipleMatches(
  taskId: string,
  matches: { sessionId: string; task: Task }[]
): { sessionId: string; task: Task } {
  if (matches.length === 1) {
    debugLog(
      `  ${DIM}Task #${taskId} found in session ${matches[0]!.sessionId.slice(0, 8)}... (not current session)${RESET}`
    )
    return matches[0]!
  }
  const sessionList = matches
    .map((m) => `  - ${m.sessionId.slice(0, 8)}... [${m.task.status}]: ${m.task.subject}`)
    .join("\n")
  throw new Error(
    `Task #${taskId} exists in ${matches.length} sessions. Use --session <id> to disambiguate:\n${sessionList}`
  )
}

async function resolveUnprefixedTask(
  taskId: string,
  primarySessionId: string,
  filterCwd: string | undefined,
  tasksDir: string,
  projectsDir: string
): Promise<{ sessionId: string; task: Task }> {
  const tasks = await readTasks(primarySessionId, tasksDir)
  const task = tasks.find((t) => t.id === taskId)
  if (task) return { sessionId: primarySessionId, task }

  let matches = await findTaskAcrossSessions(taskId, filterCwd, tasksDir, projectsDir)
  if (matches.length === 0) {
    matches = await findInOrphanUnprefixed(taskId, filterCwd, tasksDir, projectsDir)
  }
  if (matches.length > 0) return handleMultipleMatches(taskId, matches)

  const recentHint = await buildRecentTasksHint(primarySessionId, tasksDir)
  throw new Error(`Task #${taskId} not found in any session for this project.${recentHint}`)
}

export async function resolveTaskById(
  taskId: string,
  primarySessionId: string,
  filterCwd?: string,
  tasksDir = createDefaultTaskStore().tasksDir,
  projectsDir = createDefaultTaskStore().projectsDir
): Promise<{ sessionId: string; task: Task }> {
  const { prefix } = parseTaskId(taskId)
  if (prefix !== null) {
    return resolvePrefixedTaskId({
      taskId,
      prefix,
      primarySessionId,
      filterCwd,
      tasksDir,
      projectsDir,
    })
  }
  return resolveUnprefixedTask(taskId, primarySessionId, filterCwd, tasksDir, projectsDir)
}

/**
 * Return the set of session IDs in tasksDir that are NOT indexed under any
 * project transcript directory. These are "orphan" sessions created during the
 * compaction gap (TaskCreate runs before the transcript .jsonl is written).
 * Used by the task renderer to annotate tasks with a [recovered] indicator.
 */
export async function getOrphanSessionIds(
  tasksDir = createDefaultTaskStore().tasksDir,
  projectsDir = createDefaultTaskStore().projectsDir
): Promise<Set<string>> {
  const allIndexed = await getAllProjectSessionIds(projectsDir)
  let entries: string[]
  try {
    entries = await readdir(tasksDir)
  } catch {
    return new Set()
  }
  const orphans = new Set<string>()
  for (const s of entries) {
    if (!allIndexed.has(s)) orphans.add(s)
  }
  return orphans
}

/**
 * Collect all incomplete tasks across all project sessions.
 * Uses session-meta index to skip sessions with no open tasks (O(1) per session).
 * Falls back to full readTasks when meta is absent.
 */
export async function collectIncompleteTasks(
  filterCwd?: string,
  tasksDir = createDefaultTaskStore().tasksDir,
  projectsDir = createDefaultTaskStore().projectsDir
): Promise<{ sessionId: string; task: Task }[]> {
  const sessions = await getSessions(filterCwd, tasksDir, projectsDir)
  const results: { sessionId: string; task: Task }[] = []
  for (const sessionId of sessions) {
    // Fast skip: if session meta reports zero open tasks, skip the full read.
    const meta = await readSessionMeta(sessionId, tasksDir)
    if (meta && meta.openCount === 0) continue

    const tasks = await readTasks(sessionId, tasksDir)
    for (const task of tasks) {
      if (task.status === "pending" || task.status === "in_progress") {
        results.push({ sessionId, task })
      }
    }
  }
  return results
}

// Re-export ID utilities for consumers that previously imported from tasks.ts
export { compareTaskIds, parseTaskId, sessionPrefix }
