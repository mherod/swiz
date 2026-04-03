import { stat } from "node:fs/promises"
import { join } from "node:path"
import { uniq } from "lodash-es"
import { getHomeDir } from "./home.ts"
import { projectKeyFromCwd } from "./project-key.ts"
import { createDefaultTaskStore } from "./task-roots.ts"
import { findAllProviderSessions, type Session } from "./transcript-utils.ts"

export interface SessionDeletionTargets {
  matchedSessions: Session[]
  sessionIds: string[]
  transcriptPaths: string[]
  taskDirPaths: string[]
  daemonCapturePaths: string[]
}

export interface SessionDeletionResult {
  deletedCount: number
  failedPaths: string[]
  sessionIds: string[]
}

export async function defaultTrashPath(path: string): Promise<boolean> {
  const proc = Bun.spawn(["trash", path], { stdout: "pipe", stderr: "pipe" })
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return proc.exitCode === 0
}

export async function resolveSessionDeletionTargets(
  cwd: string,
  sessionId: string
): Promise<SessionDeletionTargets> {
  const allSessions = await findAllProviderSessions(cwd)
  const matchedSessions = allSessions.filter(
    (session) => session.id === sessionId || session.id.startsWith(sessionId)
  )
  const transcriptPaths = uniq(matchedSessions.map((session) => session.path))
  const sessionIds = uniq(matchedSessions.map((session) => session.id))
  const { tasksDir } = createDefaultTaskStore()
  const projectKey = projectKeyFromCwd(cwd)
  const homeDir = getHomeDir()

  const taskDirPaths: string[] = []
  const daemonCapturePaths: string[] = []
  for (const id of sessionIds) {
    const taskDirPath = join(tasksDir, id)
    try {
      const info = await stat(taskDirPath)
      if (info.isDirectory()) taskDirPaths.push(taskDirPath)
    } catch {
      // no task directory for this session
    }

    const capturePath = join(
      homeDir,
      ".swiz",
      "daemon",
      "session-tool-calls",
      projectKey,
      `${encodeURIComponent(id)}.jsonl`
    )
    try {
      const info = await stat(capturePath)
      if (info.isFile()) daemonCapturePaths.push(capturePath)
    } catch {
      // no persisted capture log for this session
    }
  }

  return {
    matchedSessions,
    sessionIds,
    transcriptPaths,
    taskDirPaths,
    daemonCapturePaths,
  }
}

export async function deleteSessionData(
  targets: SessionDeletionTargets,
  trashPath: (path: string) => Promise<boolean> = defaultTrashPath
): Promise<SessionDeletionResult> {
  const failedPaths: string[] = []
  let deletedCount = 0

  for (const path of targets.transcriptPaths) {
    if (await trashPath(path)) deletedCount++
    else failedPaths.push(path)
  }

  for (const path of targets.taskDirPaths) {
    if (await trashPath(path)) deletedCount++
    else failedPaths.push(path)
  }

  for (const path of targets.daemonCapturePaths) {
    if (await trashPath(path)) deletedCount++
    else failedPaths.push(path)
  }

  return {
    deletedCount,
    failedPaths,
    sessionIds: targets.sessionIds,
  }
}
