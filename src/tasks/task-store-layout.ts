/** Layout compatibility and conservative, atomic migration of legacy project stores. */
import { lstat, mkdir, readdir, rename, rm, rmdir } from "node:fs/promises"
import { join } from "node:path"
import { createDefaultTaskStore } from "../task-roots.ts"
import {
  isSafeSessionId,
  PROJECT_TASK_NAMESPACE,
  projectStoreKey,
  sessionDirPath,
  sessionStoreKey,
  type TaskStoreKey,
} from "./task-store-path.ts"

/** Derived index a store keeps beside its task records; rebuilt on the next write. */
const SESSION_META_FILENAME = ".session-meta.json"

/** Append-only JSONL history; both stores always hold one, so a merge must union them. */
const AUDIT_LOG_FILENAME = ".audit-log.jsonl"

/**
 * Union two append-only audit logs, destination history first.
 *
 * Ordering is by store rather than by global timestamp: entries are read by
 * task id, and rewriting a log to interleave it risks corrupting a file whose
 * whole contract is that it is only ever appended to.
 */
async function appendAuditLog(from: string, to: string): Promise<void> {
  const source = await Bun.file(from).text()
  if (source.length > 0) {
    const existing = await Bun.file(to).text()
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
    await Bun.write(to, `${existing}${separator}${source}`)
  }
  await rm(from, { force: true })
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path)
    if (!entry.isDirectory()) throw new Error(`Task store is not a directory: ${path}`)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

async function metadata(dir: string): Promise<{ cwd?: string; storeKind?: "project" | "session" }> {
  try {
    const meta = await Bun.file(join(dir, SESSION_META_FILENAME)).json()
    return {
      cwd: typeof meta.cwd === "string" && meta.cwd ? meta.cwd : undefined,
      storeKind:
        meta.storeKind === "project" || meta.storeKind === "session" ? meta.storeKind : undefined,
    }
  } catch {
    return {}
  }
}

function projectAddressKey(address: string): Extract<TaskStoreKey, { kind: "project" }> {
  return { kind: "project", key: address }
}

/**
 * Whether a bare address really names a project store.
 *
 * Either a `.projects/<key>` leftover is still there, or the flat directory
 * exists and its own metadata claims the project kind. The metadata clause is
 * what keeps a native session store from answering to a project address now
 * that both kinds resolve to the same path.
 */
async function addressesProjectStore(
  key: Extract<TaskStoreKey, { kind: "project" }>,
  storeKind: "project" | "session" | undefined,
  tasksDir: string
): Promise<boolean> {
  if (!isSafeSessionId(key, tasksDir)) return false
  if ((await namespacedProjectStore(key, tasksDir)) !== null) return true
  return storeKind === "project" && (await directoryExists(sessionDirPath(key, tasksDir)))
}

/** Compatibility for string-based CLI/recovery addresses, without making read operations migrate. */
export async function resolveLegacyTaskStoreKey(
  address: string,
  cwd?: string,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<TaskStoreKey> {
  if (address.startsWith(`${PROJECT_TASK_NAMESPACE}/`)) {
    return { kind: "project", key: address.slice(PROJECT_TASK_NAMESPACE.length + 1) }
  }
  const session = sessionStoreKey(address)
  if (!isSafeSessionId(session, tasksDir)) return session
  // Both kinds share the flat namespace, so the directory alone cannot say which
  // one an address names — the path is identical either way. Only the store's own
  // `storeKind` distinguishes them, and without this check every native session
  // store resolved as a project address simply because its directory existed.
  const meta = await metadata(sessionDirPath(session, tasksDir))
  if (meta.storeKind === "session") return session
  const project = projectAddressKey(address)
  if (await addressesProjectStore(project, meta.storeKind, tasksDir)) return project
  const owner = meta.cwd ?? cwd
  return owner && projectStoreKey(owner).key === address ? projectStoreKey(owner) : session
}

/**
 * The reserved namespace directory, but only when it is a real directory.
 *
 * A symlink here is never followed: resolving through it would read and fold
 * task records from outside the store, so it is treated exactly like an absent
 * namespace and the flat store is used instead.
 */
async function namespaceDir(tasksDir: string): Promise<string | null> {
  const parent = join(tasksDir, PROJECT_TASK_NAMESPACE)
  const entry = await lstat(parent).catch(() => null)
  return entry?.isDirectory() ? parent : null
}

/** Where the short-lived `.projects` split put a project store, if anything is still there. */
async function namespacedProjectStore(
  key: Extract<TaskStoreKey, { kind: "project" }>,
  tasksDir: string
): Promise<string | null> {
  const parent = await namespaceDir(tasksDir)
  if (!parent) return null
  const dir = join(parent, key.key)
  return (await directoryExists(dir)) ? dir : null
}

/**
 * Resolve a store's directory. Both kinds live flat in the task store.
 *
 * A project store may still have a `.projects/<key>` directory left by the
 * reverted split. It is read from until a write folds it back, so those tasks
 * stay visible in the meantime; nothing here refuses. The previous version
 * threw whenever both directories existed, which took out every caller —
 * including the reads that hooks run before any write — and left no path to
 * the merge that would have cleared it.
 */
export async function readTaskStorePath(key: TaskStoreKey, tasksDir: string): Promise<string> {
  const home = sessionDirPath(key, tasksDir)
  if (key.kind === "session") return home
  if (await directoryExists(home)) return home
  return (await namespacedProjectStore(key, tasksDir)) ?? home
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

/**
 * Fold a pre-split project store into its namespaced home.
 *
 * Used when both directories exist, which a plain rename cannot resolve. Task
 * records move only into free names, so a namespaced record is never
 * overwritten by its older flat counterpart. `.session-meta.json` is the one
 * entry dropped rather than preserved: it is a derived index that
 * `updateSessionMeta` rebuilds from the task files on the next write, and
 * keeping the stale copy would hold the legacy directory open and with it the
 * conflict this merge exists to clear.
 *
 * `.audit-log.jsonl` is appended rather than refused. It is the one file both
 * stores are guaranteed to hold, so treating it as a name collision made the
 * merge impossible for every project that ever wrote tasks to both — and an
 * append-only log has an unambiguous union: keep the destination's history,
 * then the source's. Neither copy loses an entry.
 *
 * Any other genuine collision is left in place and reported. Silently choosing
 * a winner there would hide a task, which is the outcome the conflict guard was
 * written to prevent.
 */
async function mergeProjectStore(legacy: string, target: string): Promise<void> {
  const collisions: string[] = []
  for (const entry of await readdir(legacy)) {
    const from = join(legacy, entry)
    const to = join(target, entry)
    if (!(await pathExists(to))) {
      await rename(from, to)
      continue
    }
    if (entry === SESSION_META_FILENAME) {
      await rm(from, { force: true })
      continue
    }
    if (entry === AUDIT_LOG_FILENAME) {
      await appendAuditLog(from, to)
      continue
    }
    collisions.push(entry)
  }
  if (collisions.length > 0) {
    throw new Error(
      `Cannot merge task store ${legacy} into ${target}: ` +
        `${collisions.join(", ")} exist in both. Both copies were preserved; reconcile them by hand.`
    )
  }
  await rmdir(legacy)
}

/**
 * Return this project's flat store, folding back anything the `.projects`
 * split left behind. No ownership check is needed: the namespaced path encodes
 * the project key, so its contents cannot belong to another project.
 */
async function migrateProjectStore(
  key: Extract<TaskStoreKey, { kind: "project" }>,
  tasksDir: string
): Promise<string> {
  const home = sessionDirPath(key, tasksDir)
  const namespaced = await namespacedProjectStore(key, tasksDir)
  if (!namespaced) {
    await mkdir(home, { recursive: true })
    return home
  }
  if (!(await directoryExists(home))) {
    await rename(namespaced, home)
    return home
  }
  await mergeProjectStore(namespaced, home)
  return home
}

/**
 * Serialize the fold-back across processes; never rename over a concurrently created destination.
 *
 * The lock is only taken when something is actually left under `.projects`, so
 * the ordinary write path neither creates nor touches that directory — the flat
 * store is the whole layout again. The lock lives inside the reserved namespace
 * because {@link isSafeSessionId} excludes it there; a lock directory sitting
 * loose in the task store would be enumerated as a session.
 */
export async function prepareTaskStoreWrite(key: TaskStoreKey, tasksDir: string): Promise<string> {
  const target = sessionDirPath(key, tasksDir)
  if (key.kind === "session") {
    await mkdir(target, { recursive: true })
    return target
  }
  const parent = await namespaceDir(tasksDir)
  if (!parent || !(await namespacedProjectStore(key, tasksDir))) {
    await mkdir(target, { recursive: true })
    return target
  }
  const lock = join(parent, `.migration-${key.key}.lock`)
  const deadline = Date.now() + 5000
  while (true) {
    try {
      await mkdir(lock)
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // The namespace vanished between the check above and this lock: another
      // process folded the last store back and removed it. There is nothing
      // left to migrate, so take the flat home rather than recreating `.projects`.
      if (code === "ENOENT") {
        await mkdir(target, { recursive: true })
        return target
      }
      if (code !== "EEXIST" || Date.now() >= deadline) throw error
      await Bun.sleep(10)
    }
  }
  try {
    return await migrateProjectStore(key, tasksDir)
  } finally {
    await rmdir(lock).catch(() => {})
    // Once the last store has folded back the namespace itself goes too, so the
    // task store is flat again rather than flat beside an empty `.projects`.
    // `rmdir` succeeds only when it is empty, so a concurrent lock or a store
    // still awaiting its own fold-back simply keeps it.
    await rmdir(parent).catch(() => {})
  }
}

/** Only directories in the native session namespace qualify, including during gradual migration. */
export async function listSessionStoreIds(tasksDir: string): Promise<string[]> {
  const entries = await readdir(tasksDir, { withFileTypes: true }).catch(() => [])
  const sessions: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeSessionId(sessionStoreKey(entry.name), tasksDir)) continue
    // Old path keys with damaged ownership metadata must not become native sessions.
    const meta = await metadata(sessionDirPath(sessionStoreKey(entry.name), tasksDir))
    if (meta.storeKind === "session") {
      sessions.push(entry.name)
      continue
    }
    if (entry.name.startsWith("-")) continue
    if ((await resolveLegacyTaskStoreKey(entry.name, undefined, tasksDir)).kind === "session")
      sessions.push(entry.name)
  }
  return sessions
}

/** Project addresses are enumerated separately from native session IDs. */
export async function listProjectStoreKeys(tasksDir: string): Promise<string[]> {
  const keys = new Set<string>()
  const parent = await namespaceDir(tasksDir)
  const entries = parent ? await readdir(parent, { withFileTypes: true }).catch(() => []) : []
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      !entry.name.startsWith(".") &&
      isSafeSessionId({ kind: "project", key: entry.name }, tasksDir)
    )
      keys.add(entry.name)
  }
  for (const candidate of await legacyProjectCandidates(tasksDir)) {
    if (candidate.cwd) keys.add(candidate.directory)
  }
  return [...keys]
}

async function legacyProjectCandidates(tasksDir: string) {
  const entries = await readdir(tasksDir, { withFileTypes: true }).catch(() => [])
  const candidates: Array<{ directory: string; cwd?: string }> = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeSessionId(sessionStoreKey(entry.name), tasksDir)) continue
    const meta = await metadata(sessionDirPath(sessionStoreKey(entry.name), tasksDir))
    if (meta.storeKind === "session") continue
    if (meta.cwd && projectStoreKey(meta.cwd).key === entry.name) {
      candidates.push({ directory: entry.name, cwd: meta.cwd })
    } else if (entry.name.startsWith("-")) {
      candidates.push({ directory: entry.name })
    }
  }
  return candidates
}

export interface TaskStoreMigrationResult {
  directory: string
  status: "ready" | "migrated" | "held"
  reason?: string
}

/** One namespaced store's disposition; a failure is reported, never allowed to abort the sweep. */
async function foldBackNamespacedStore(
  name: string,
  tasksDir: string,
  apply: boolean
): Promise<TaskStoreMigrationResult> {
  const key: TaskStoreKey = { kind: "project", key: name }
  if (!isSafeSessionId(key, tasksDir)) {
    return {
      directory: name,
      status: "held",
      reason: "Project key does not resolve inside the task store; preserved untouched.",
    }
  }
  try {
    if (apply) await prepareTaskStoreWrite(key, tasksDir)
    return { directory: name, status: apply ? "migrated" : "ready" }
  } catch (error) {
    return {
      directory: name,
      status: "held",
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Fold every store the `.projects` split left behind back into the flat layout.
 *
 * The direction is the reverse of the one this function originally shipped:
 * flat is the home layout, and a namespaced directory is the leftover. No
 * ownership check is needed because the namespaced path encodes the project
 * key, so its contents cannot belong to another project. A store whose
 * fold-back hits a genuine file collision is reported `held` with both copies
 * intact rather than resolved by guesswork.
 */
export async function migrateLegacyProjectStores(
  tasksDir: string,
  apply = false
): Promise<TaskStoreMigrationResult[]> {
  const parent = await namespaceDir(tasksDir)
  const entries = parent ? await readdir(parent, { withFileTypes: true }).catch(() => []) : []
  const results: TaskStoreMigrationResult[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue
    results.push(await foldBackNamespacedStore(entry.name, tasksDir, apply))
  }
  return results
}
