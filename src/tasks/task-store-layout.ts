/** Layout compatibility and conservative, atomic migration of legacy project stores. */
import { lstat, mkdir, readdir, rename, rmdir } from "node:fs/promises"
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
    const meta = await Bun.file(join(dir, ".session-meta.json")).json()
    return {
      cwd: typeof meta.cwd === "string" && meta.cwd ? meta.cwd : undefined,
      storeKind:
        meta.storeKind === "project" || meta.storeKind === "session" ? meta.storeKind : undefined,
    }
  } catch {
    return {}
  }
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
  const project: TaskStoreKey = { kind: "project", key: address }
  if (
    isSafeSessionId(project, tasksDir) &&
    (await directoryExists(sessionDirPath(project, tasksDir)))
  )
    return project
  const owner = (await metadata(sessionDirPath(session, tasksDir))).cwd ?? cwd
  return owner && projectStoreKey(owner).key === address ? projectStoreKey(owner) : session
}

/** Refuse conflicts instead of choosing one directory and hiding the other's tasks. */
export async function readTaskStorePath(key: TaskStoreKey, tasksDir: string): Promise<string> {
  const target = sessionDirPath(key, tasksDir)
  if (key.kind === "session") return target
  await directoryExists(join(tasksDir, PROJECT_TASK_NAMESPACE))
  const legacy = sessionDirPath(sessionStoreKey(key.key), tasksDir)
  const [hasTarget, hasLegacy] = await Promise.all([
    directoryExists(target),
    directoryExists(legacy),
  ])
  const nativeSession = hasLegacy && (await metadata(legacy)).storeKind === "session"
  if (hasTarget && hasLegacy && !nativeSession && (await directoryExists(legacy)))
    throw new Error(
      `Conflicting task stores: ${legacy} and ${target}. Reconcile their contents before writing.`
    )
  return hasLegacy && !nativeSession ? legacy : target
}

async function migrateProjectStore(
  key: Extract<TaskStoreKey, { kind: "project" }>,
  tasksDir: string,
  cwd?: string
): Promise<string> {
  const target = sessionDirPath(key, tasksDir)
  const source = await readTaskStorePath(key, tasksDir)
  if (source === target) {
    await mkdir(target, { recursive: true })
    return target
  }
  const owner = (await metadata(source)).cwd ?? cwd
  if (!owner || projectStoreKey(owner).key !== key.key) {
    throw new Error(
      `Cannot migrate task store ${source}: cwd ownership is missing or conflicts with its project key. Existing files were preserved.`
    )
  }
  await rename(source, target)
  return target
}

/** Serialize migration across processes; never rename over a concurrently created destination. */
export async function prepareTaskStoreWrite(
  key: TaskStoreKey,
  tasksDir: string,
  cwd?: string
): Promise<string> {
  const target = sessionDirPath(key, tasksDir)
  if (key.kind === "session") {
    await mkdir(target, { recursive: true })
    return target
  }
  const parent = join(tasksDir, PROJECT_TASK_NAMESPACE)
  await directoryExists(parent)
  await mkdir(parent, { recursive: true })
  const lock = join(parent, `.migration-${key.key}.lock`)
  const deadline = Date.now() + 5000
  while (true) {
    try {
      await mkdir(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error
      await Bun.sleep(10)
    }
  }
  try {
    return await migrateProjectStore(key, tasksDir, cwd)
  } finally {
    await rmdir(lock)
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
  const parent = join(tasksDir, PROJECT_TASK_NAMESPACE)
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => [])
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

/** Inspect legacy root entries; only metadata-confirmed project directories are movable. */
export async function migrateLegacyProjectStores(
  tasksDir: string,
  apply = false
): Promise<TaskStoreMigrationResult[]> {
  const results: TaskStoreMigrationResult[] = []
  for (const candidate of await legacyProjectCandidates(tasksDir)) {
    if (!candidate.cwd) {
      results.push({
        directory: candidate.directory,
        status: "held",
        reason: "Missing or contradictory cwd metadata; preserved for explicit legacy access.",
      })
      continue
    }
    const key = projectStoreKey(candidate.cwd)
    try {
      await readTaskStorePath(key, tasksDir)
      if (apply) await prepareTaskStoreWrite(key, tasksDir)
      results.push({ directory: candidate.directory, status: apply ? "migrated" : "ready" })
    } catch (error) {
      results.push({
        directory: candidate.directory,
        status: "held",
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}
