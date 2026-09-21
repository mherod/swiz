import { stat } from "node:fs/promises"
import { join } from "node:path"
import { getIssueStoreDbPath } from "../../issue-store.ts"
import { projectKeyFromCwd } from "../../project-key.ts"
import { getProjectSettingsPath, getStatePath, getSwizSettingsPath } from "../../settings.ts"
import { createDefaultTaskStore } from "../../task-roots.ts"
import type { WarmStatusLineSnapshot } from "../status-line.ts"

const GITHUB_REFRESH_WINDOW_MS = 20_000

export interface SnapshotFingerprint {
  projectSettingsMtimeMs: number
  projectStateMtimeMs: number
  globalSettingsMtimeMs: number
  ghCacheMtimeMs: number
  /**
   * Mtime of this project's task store directory.
   *
   * Without it a cached snapshot kept its task counts through every task write,
   * refreshing only when an unrelated input changed or the 20s GitHub bucket
   * rolled — so the segment could show a queue up to 20s out of date while a
   * freshly computed one showed the truth.
   */
  taskStoreMtimeMs: number
  githubBucket: number
}

export interface CachedSnapshot {
  snapshot: WarmStatusLineSnapshot
  fingerprint: SnapshotFingerprint
}

export function hasSnapshotInvalidated(
  previous: SnapshotFingerprint | null,
  next: SnapshotFingerprint
): boolean {
  if (!previous) return true
  return (
    previous.projectSettingsMtimeMs !== next.projectSettingsMtimeMs ||
    previous.projectStateMtimeMs !== next.projectStateMtimeMs ||
    previous.globalSettingsMtimeMs !== next.globalSettingsMtimeMs ||
    previous.ghCacheMtimeMs !== next.ghCacheMtimeMs ||
    previous.taskStoreMtimeMs !== next.taskStoreMtimeMs ||
    previous.githubBucket !== next.githubBucket
  )
}

/** Directory mtime, which moves whenever a task record is created, replaced or removed. */
async function safeDirMtime(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs ?? 0
  } catch {
    return 0
  }
}

async function safeMtime(path: string | null): Promise<number> {
  if (!path) return 0
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) return 0
    const info = await file.stat()
    return info.mtimeMs ?? 0
  } catch {
    return 0
  }
}

export async function buildSnapshotFingerprint(
  cwd: string,
  nowMs = Date.now()
): Promise<SnapshotFingerprint> {
  const globalSettingsPath = getSwizSettingsPath()
  const { tasksDir } = createDefaultTaskStore()
  const [
    projectSettingsMtimeMs,
    projectStateMtimeMs,
    globalSettingsMtimeMs,
    ghCacheMtimeMs,
    taskStoreMtimeMs,
  ] = await Promise.all([
    safeMtime(getProjectSettingsPath(cwd)),
    safeMtime(getStatePath(cwd)),
    safeMtime(globalSettingsPath),
    safeMtime(getIssueStoreDbPath()),
    safeDirMtime(join(tasksDir, projectKeyFromCwd(cwd))),
  ])
  return {
    projectSettingsMtimeMs,
    projectStateMtimeMs,
    globalSettingsMtimeMs,
    ghCacheMtimeMs,
    taskStoreMtimeMs,
    githubBucket: Math.floor(nowMs / GITHUB_REFRESH_WINDOW_MS),
  }
}
