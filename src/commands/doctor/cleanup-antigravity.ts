/**
 * Antigravity session discovery for `swiz doctor clean`.
 *
 * Antigravity keeps session state outside the Claude projects tree, in two
 * layouts that can coexist on one machine:
 *
 *   CLI     ~/.gemini/antigravity-cli/brain/<id>/            (transcripts, task.md)
 *           ~/.gemini/antigravity-cli/conversations/<id>*    (conversation artifacts)
 *   Legacy  ~/.gemini/antigravity/brain/<id>/
 *           ~/.gemini/antigravity/conversations/<id>.pb
 *
 * A session is the union of its brain directory and every conversation artifact
 * sharing its id, so both halves are trashed together and neither is orphaned.
 */
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { type ProjectResult, pathStats, type SessionInfo } from "./cleanup-fs.ts"

interface AntigravityRoot {
  /** Group label shown in the cleanup report. */
  label: string
  brainDir: string
  conversationsDir: string
}

export function antigravityRoots(homeDir: string): AntigravityRoot[] {
  const cliRoot = join(homeDir, ".gemini", "antigravity-cli")
  const legacyRoot = join(homeDir, ".gemini", "antigravity")
  return [
    {
      label: "(antigravity sessions)",
      brainDir: join(cliRoot, "brain"),
      conversationsDir: join(cliRoot, "conversations"),
    },
    {
      label: "(antigravity legacy sessions)",
      brainDir: join(legacyRoot, "brain"),
      conversationsDir: join(legacyRoot, "conversations"),
    },
  ]
}

/**
 * Map a conversation entry name back to its session id. Handles both bare
 * `<id>` directories and suffixed artifacts such as `<id>.pb`.
 */
function conversationSessionId(entryName: string): string {
  const dot = entryName.indexOf(".")
  return dot > 0 ? entryName.slice(0, dot) : entryName
}

async function listEntries(dirPath: string): Promise<string[]> {
  try {
    return await readdir(dirPath)
  } catch {
    return []
  }
}

async function collectSessionPaths(root: AntigravityRoot): Promise<Map<string, string[]>> {
  const byId = new Map<string, string[]>()

  for (const entry of await listEntries(root.brainDir)) {
    if (entry.startsWith(".")) continue
    byId.set(entry, [join(root.brainDir, entry)])
  }

  for (const entry of await listEntries(root.conversationsDir)) {
    if (entry.startsWith(".")) continue
    const id = conversationSessionId(entry)
    if (!id) continue
    const paths = byId.get(id) ?? []
    paths.push(join(root.conversationsDir, entry))
    byId.set(id, paths)
  }

  return byId
}

async function buildSessionInfo(sessionId: string, paths: string[]): Promise<SessionInfo> {
  let sizeBytes = 0
  let mtimeMs = 0
  for (const path of paths) {
    const stats = await pathStats(path)
    sizeBytes += stats.sizeBytes
    if (stats.newestMtimeMs > mtimeMs) mtimeMs = stats.newestMtimeMs
  }
  return {
    sessionId,
    paths,
    mtimeMs,
    sizeBytes,
    taskDirPath: null,
    taskDirSizeBytes: 0,
  }
}

/**
 * Scan both Antigravity layouts and split each into kept and trashable
 * sessions. Layouts with no sessions on disk are omitted entirely.
 */
export async function findAntigravityCleanupGroups(
  homeDir: string,
  cutoffMs: number
): Promise<ProjectResult[]> {
  const groups: ProjectResult[] = []

  for (const root of antigravityRoots(homeDir)) {
    const byId = await collectSessionPaths(root)
    if (byId.size === 0) continue

    const keep: SessionInfo[] = []
    const old: SessionInfo[] = []
    for (const [sessionId, paths] of byId) {
      const info = await buildSessionInfo(sessionId, paths)
      if (info.mtimeMs < cutoffMs) old.push(info)
      else keep.push(info)
    }

    groups.push({ name: root.label, keep, old, stale: false })
  }

  return groups
}
