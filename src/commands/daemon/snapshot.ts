import { getGitBranchStatus } from "../../git-helpers.ts"
import { getIssueStoreDbPath } from "../../issue-store.ts"
import { getProjectSettingsPath, getStatePath, getSwizSettingsPath } from "../../settings.ts"
import type { WarmStatusLineSnapshot } from "../status-line.ts"

const GITHUB_REFRESH_WINDOW_MS = 20_000

export interface SnapshotFingerprint {
  git: string
  projectSettingsMtimeMs: number
  projectStateMtimeMs: number
  globalSettingsMtimeMs: number
  ghCacheMtimeMs: number
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
    previous.git !== next.git ||
    previous.projectSettingsMtimeMs !== next.projectSettingsMtimeMs ||
    previous.projectStateMtimeMs !== next.projectStateMtimeMs ||
    previous.globalSettingsMtimeMs !== next.globalSettingsMtimeMs ||
    previous.ghCacheMtimeMs !== next.ghCacheMtimeMs ||
    previous.githubBucket !== next.githubBucket
  )
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

export async function buildSnapshotFingerprint(cwd: string): Promise<SnapshotFingerprint> {
  const globalSettingsPath = getSwizSettingsPath()
  const [
    gitStatus,
    projectSettingsMtimeMs,
    projectStateMtimeMs,
    globalSettingsMtimeMs,
    ghCacheMtimeMs,
  ] = await Promise.all([
    getGitBranchStatus(cwd),
    safeMtime(getProjectSettingsPath(cwd)),
    safeMtime(getStatePath(cwd)),
    safeMtime(globalSettingsPath),
    safeMtime(getIssueStoreDbPath()),
  ])
  return {
    git: gitStatus
      ? `${gitStatus.branch}:${gitStatus.ahead}:${gitStatus.behind}:${gitStatus.staged}:${gitStatus.unstaged}:${gitStatus.untracked}:${gitStatus.conflicts}:${gitStatus.stash}:${gitStatus.changedFallback}`
      : "not-git",
    projectSettingsMtimeMs,
    projectStateMtimeMs,
    globalSettingsMtimeMs,
    ghCacheMtimeMs,
    githubBucket: Math.floor(Date.now() / GITHUB_REFRESH_WINDOW_MS),
  }
}
