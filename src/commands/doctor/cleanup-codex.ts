/** Codex rollout discovery for `swiz doctor clean`, using last activity on disk. */
import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"
import type { ProjectResult, SessionInfo } from "./cleanup-fs.ts"

const ROLLOUT_RE =
  /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

async function collectRollouts(directory: string, sessions: SessionInfo[]): Promise<void> {
  // Do not follow directory or file symlinks outside the session stores.
  if (!(await lstat(directory).catch(() => null))?.isDirectory()) return
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await collectRollouts(path, sessions)
      continue
    }
    const sessionId = entry.isFile() ? ROLLOUT_RE.exec(entry.name)?.[1] : undefined
    if (!sessionId) continue
    const info = await lstat(path).catch(() => null)
    if (!info?.isFile()) continue
    sessions.push({
      sessionId,
      paths: [path],
      mtimeMs: info.mtimeMs,
      sizeBytes: info.size,
      taskDirPath: null,
      taskDirSizeBytes: 0,
      // Old session_meta and compaction records are required to resume a kept rollout.
      preserveTranscript: true,
    })
  }
}

export async function findCodexCleanupGroups(
  homeDir: string,
  _cutoffMs?: number
): Promise<ProjectResult[]> {
  const root = join(homeDir, ".codex")
  if (!(await lstat(root).catch(() => null))?.isDirectory()) return []
  const groups: ProjectResult[] = []
  for (const [directory, name] of [
    ["sessions", "(codex sessions)"],
    ["archived_sessions", "(codex archived sessions)"],
  ] as const) {
    const sessions: SessionInfo[] = []
    await collectRollouts(join(root, directory), sessions)
    if (sessions.length === 0) continue
    const unarchived = directory === "sessions"
    groups.push({
      provider: "codex",
      cleanupSkipped: unarchived,
      name,
      keep: unarchived ? sessions : [],
      old: unarchived ? [] : sessions,
      stale: false,
    })
  }
  return groups
}
