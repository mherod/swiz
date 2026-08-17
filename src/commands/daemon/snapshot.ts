import { getIssueStoreDbPath } from "../../issue-store.ts"
import { getProjectSettingsPath, getStatePath, getSwizSettingsPath } from "../../settings.ts"
import type { WarmStatusLineSnapshot } from "../status-line.ts"

const GITHUB_REFRESH_WINDOW_MS = 20_000

export interface SnapshotFingerprint {
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

export async function buildSnapshotFingerprint(
  cwd: string,
  nowMs = Date.now()
): Promise<SnapshotFingerprint> {
  const globalSettingsPath = getSwizSettingsPath()
  const [projectSettingsMtimeMs, projectStateMtimeMs, globalSettingsMtimeMs, ghCacheMtimeMs] =
    await Promise.all([
      safeMtime(getProjectSettingsPath(cwd)),
      safeMtime(getStatePath(cwd)),
      safeMtime(globalSettingsPath),
      safeMtime(getIssueStoreDbPath()),
    ])
  return {
    projectSettingsMtimeMs,
    projectStateMtimeMs,
    globalSettingsMtimeMs,
    ghCacheMtimeMs,
    githubBucket: Math.floor(nowMs / GITHUB_REFRESH_WINDOW_MS),
  }
}
