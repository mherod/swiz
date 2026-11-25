import type { Stats } from "node:fs"
import { lstat } from "node:fs/promises"
import { resolve } from "node:path"
import { LRUCache } from "lru-cache"
import { getGitClient } from "./git/client.ts"
import type { PostToolHookInput, ToolHookInput } from "./schemas.ts"
import { isPathInsideRoot, resolveSessionEditPath } from "./session-edit-identity.ts"
import type { FileSnapshot } from "./session-edit-observations.ts"
import { canonicalClaimPath, fileClaimProjectKey } from "./session-file-claims.ts"
import { extractFileEditTargetPaths, isFileEditTool, isShellTool } from "./tool-matchers.ts"

export const SESSION_EDIT_OBSERVATION_MATCHER =
  "Edit|Write|NotebookEdit|Bash|exec|functions.exec|wait|functions.wait|write_stdin|functions.write_stdin"

export interface EditObservationIdentity {
  cwd: string
  project: string
  session: string
  tool: string
}

export function editObservationIdentity(input: ToolHookInput): EditObservationIdentity | null {
  const { cwd, session_id: session } = input
  const tool = input.tool_use_id ?? input.call_id
  if (!cwd || !session || typeof tool !== "string" || !tool.trim()) return null
  return { cwd, session, tool, project: fileClaimProjectKey(cwd) }
}

export function failedEditResponse(input: PostToolHookInput): boolean {
  if (input.hook_event_name === "PostToolUseFailure") return true
  const response = input.tool_response
  if (!response || typeof response !== "object" || Array.isArray(response)) return false
  return (
    response.isError === true ||
    response.is_error === true ||
    (typeof response.exit_code === "number" && response.exit_code !== 0)
  )
}

export function isObservedEditTool(name: string): boolean {
  return (
    isFileEditTool(name) ||
    isShellTool(name) ||
    SESSION_EDIT_OBSERVATION_MATCHER.split("|").includes(name)
  )
}

export function editContinuationInput(input: ToolHookInput): string | null {
  const args = input.tool_input
  if (!args || typeof args !== "object") return null
  if (typeof args.cell_id === "string") return `cell:${args.cell_id}`
  if ((input.tool_name ?? "").endsWith("write_stdin") && typeof args.session_id === "number")
    return `process:${args.session_id}`
  return null
}

export function editContinuationOutput(
  response: PostToolHookInput["tool_response"]
): string | null {
  if (typeof response === "string") {
    const cell = /Script running with cell ID ([\w-]+)/.exec(response)?.[1]
    return cell ? `cell:${cell}` : null
  }
  if (!response || typeof response !== "object" || Array.isArray(response)) return null
  if (typeof response.session_id === "number" && response.exit_code == null)
    return `process:${response.session_id}`
  return typeof response.cell_id === "string" ? `cell:${response.cell_id}` : null
}

export function explicitEditTargets(input: ToolHookInput): string[] {
  if (!isFileEditTool(input.tool_name ?? "")) return []
  return extractFileEditTargetPaths(input.tool_input ?? {})
}

function checkDeadline(deadline: number): void {
  if (performance.now() > deadline) throw new Error("File observation timed out")
}

/** Files up to this size are read in one call; a stream per file costs far more than the read. */
const WHOLE_READ_MAX_BYTES = 4 * 1024 * 1024

async function hashFileContent(file: Bun.BunFile, size: number, deadline: number): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256")
  if (size <= WHOLE_READ_MAX_BYTES) {
    hash.update(await file.arrayBuffer())
    checkDeadline(deadline)
    return hash.digest("hex")
  }
  const reader = file.stream().getReader()
  try {
    for (;;) {
      checkDeadline(deadline)
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
  return hash.digest("hex")
}

async function fingerprintFile(path: string, deadline: number): Promise<string | null> {
  try {
    const file = Bun.file(path)
    const stat = await file.stat()
    if (!stat.isFile()) return null
    if (stat.size > 64 * 1024 * 1024) throw new Error("File exceeds observation size limit")
    const digest = await hashFileContent(file, stat.size, deadline)
    const finalStat = await Bun.file(path).stat()
    if (stat.mtimeMs !== finalStat.mtimeMs || stat.size !== finalStat.size)
      throw new Error("File changed while capturing observation")
    return `${stat.mode}:${digest}`
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error
    return null
  }
}

interface ObservedFile {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  mode: number
  /** Symlink-free path of the file, resolved when this inode was first seen. */
  canonical: string
  fingerprint: string
}

/**
 * Fingerprints of regular files, keyed by the path git listed.
 *
 * A snapshot is taken before and after every shell or edit tool call and covers the whole
 * worktree. Resolving and hashing every file each time kept the daemon busy until the snapshot
 * deadline on each call, so a file is only resolved again when its inode changes and only read
 * again when its size, modification time or mode changes.
 */
const observedFiles = new LRUCache<string, ObservedFile>({ max: 60_000 })
const snapshotStats = { hashed: 0, reused: 0 }

/** How many files snapshots have read and hashed, and how many they answered from memory. */
export function editSnapshotStats(): { hashed: number; reused: number } {
  return { ...snapshotStats }
}

export function resetEditSnapshotCacheForTests(): void {
  observedFiles.clear()
  snapshotStats.hashed = 0
  snapshotStats.reused = 0
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  } catch {
    return null
  }
}

function sameInode(known: ObservedFile | undefined, stats: Stats): known is ObservedFile {
  return known !== undefined && known.dev === stats.dev && known.ino === stats.ino
}

function sameContentStat(known: ObservedFile, stats: Stats): boolean {
  return known.size === stats.size && known.mtimeMs === stats.mtimeMs && known.mode === stats.mode
}

interface FileObservation {
  path: string
  fingerprint: string | null
}

/** Anything that is not a plain existing file takes the exact, uncached route. */
async function observeUncached(
  root: string,
  absolute: string,
  deadline: number
): Promise<FileObservation | null> {
  const path = resolveSessionEditPath(root, absolute)
  return path ? { path, fingerprint: await fingerprintFile(path, deadline) } : null
}

async function observeFile(
  root: string,
  absolute: string,
  deadline: number
): Promise<FileObservation | null> {
  const stats = await lstatOrNull(absolute)
  if (!stats?.isFile()) return await observeUncached(root, absolute, deadline)
  const known = observedFiles.get(absolute)
  const knownInode = sameInode(known, stats)
  const canonical = knownInode ? known.canonical : canonicalClaimPath(absolute)
  if (!isPathInsideRoot(root, canonical)) return null
  if (knownInode && sameContentStat(known, stats)) {
    snapshotStats.reused += 1
    return { path: canonical, fingerprint: known.fingerprint }
  }
  const fingerprint = await fingerprintFile(canonical, deadline)
  snapshotStats.hashed += 1
  if (fingerprint !== null) {
    const { dev, ino, size, mtimeMs, mode } = stats
    observedFiles.set(absolute, { dev, ino, size, mtimeMs, mode, canonical, fingerprint })
  }
  return { path: canonical, fingerprint }
}

/** A whole-worktree snapshot catches dynamic scripts without interpreting or executing them. */
export async function captureEditSnapshot(
  cwd: string,
  extraPaths: string[] = []
): Promise<FileSnapshot> {
  const root = canonicalClaimPath(cwd)
  const listing = await getGitClient().run(
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root }
  )
  if (listing.exitCode !== 0) throw new Error("Cannot enumerate worktree files")
  const paths = [...new Set([...listing.stdout.split("\0").filter(Boolean), ...extraPaths])]
  if (paths.length > 100_000) throw new Error("Worktree exceeds observation file limit")
  const snapshot: FileSnapshot = Object.create(null)
  const deadline = performance.now() + 5_000
  let next = 0
  const results = await Promise.allSettled(
    Array.from({ length: 16 }, async () => {
      while (next < paths.length) {
        const relative = paths[next++]!
        checkDeadline(deadline)
        const observed = await observeFile(root, resolve(root, relative), deadline)
        if (observed) snapshot[observed.path] = observed.fingerprint
      }
    })
  )
  const failed = results.find((result) => result.status === "rejected")
  if (failed?.status === "rejected") throw failed.reason
  return snapshot
}
