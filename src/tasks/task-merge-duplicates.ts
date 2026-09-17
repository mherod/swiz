/**
 * Duplicate-task merging — collapses several open task records that describe
 * the same work into one.
 *
 * Hook-created stubs are the motivating case: every session that ends with
 * unpushed commits leaves its own "Push branch to remote" task behind, so the
 * project queue accumulates dozens of identical rows that no session owns.
 * `task-subject-duplicates.ts` already detects these groups for advisory
 * warnings; this module acts on them.
 *
 * Merging is confined to open work. A completed or cancelled record is
 * history — two sessions that each finished "Push branch to remote" really did
 * push twice, and collapsing that would rewrite what happened.
 *
 * Leaf module: node builtins plus the pure duplicate-grouping helpers, so both
 * the cache and the MCP server can import it without a cycle.
 */

import { unlink } from "node:fs/promises"
import { resolveTaskFilePath } from "./task-file-path.ts"
import {
  isDuplicateSubjectCandidate,
  normalizeTaskSubjectForDuplicate,
} from "./task-subject-duplicates.ts"
import { parseIsoTimestampMs } from "./task-timing.ts"

/** The fields merging needs; satisfied by both `Task` and `SessionTask`. */
export interface MergeableTask {
  id: string
  subject: string
  status: string
  description?: string
  blocks?: string[]
  blockedBy?: string[]
  startedAt?: number | null
  statusChangedAt?: string | null
}

/** in_progress outranks pending: the row someone actually picked up wins. */
function statusRank(status: string): number {
  return status === "in_progress" ? 1 : 0
}

function activityMs(task: MergeableTask): number {
  return parseIsoTimestampMs(task.statusChangedAt) ?? task.startedAt ?? 0
}

/**
 * Pick the record the group collapses into: the most advanced status, then the
 * most recent activity, then the lowest id. The id tie-break keeps the choice
 * deterministic for identical stubs, which is the common case.
 */
export function selectSurvivor<T extends MergeableTask>(group: readonly T[]): T {
  return [...group].sort((a, b) => {
    const byStatus = statusRank(b.status) - statusRank(a.status)
    if (byStatus !== 0) return byStatus
    const byActivity = activityMs(b) - activityMs(a)
    if (byActivity !== 0) return byActivity
    return a.id.localeCompare(b.id, undefined, { numeric: true })
  })[0] as T
}

function unionRefs(
  survivorId: string,
  mergedIds: ReadonlySet<string>,
  groups: ReadonlyArray<readonly string[] | undefined>
): string[] {
  const seen = new Set<string>()
  for (const refs of groups) {
    for (const ref of refs ?? []) {
      // A reference to a record that just disappeared would dangle, and a
      // self-reference would make the survivor block itself.
      if (ref === survivorId || mergedIds.has(ref)) continue
      seen.add(ref)
    }
  }
  return [...seen]
}

export interface DuplicateMergeResult<T> {
  /** The survivor, carrying the union of every duplicate's dependency edges. */
  task: T
  /** Ids of the records folded into it, in the order they were grouped. */
  mergedIds: string[]
}

/**
 * Collapse one group into a single record. Dependency edges are unioned so a
 * merge cannot silently drop a blocker; every other field comes from the
 * survivor, because the duplicates are by definition describing the same work.
 */
export function mergeGroup<T extends MergeableTask>(group: readonly T[]): DuplicateMergeResult<T> {
  const survivor = selectSurvivor(group)
  const mergedIds = group.filter((task) => task.id !== survivor.id).map((task) => task.id)
  const mergedIdSet = new Set(mergedIds)

  return {
    task: {
      ...survivor,
      blocks: unionRefs(
        survivor.id,
        mergedIdSet,
        group.map((task) => task.blocks)
      ),
      blockedBy: unionRefs(
        survivor.id,
        mergedIdSet,
        group.map((task) => task.blockedBy)
      ),
    },
    mergedIds,
  }
}

/**
 * Group open tasks by normalized subject and merge each group of more than
 * one. Returns the resulting list, preserving the input order of survivors so
 * callers that sort afterwards are unaffected.
 */
function groupOpenTasksBySubject<T extends MergeableTask>(tasks: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const task of tasks) {
    if (!isDuplicateSubjectCandidate(task)) continue
    const key = normalizeTaskSubjectForDuplicate(task.subject)
    if (!key) continue
    const existing = groups.get(key)
    if (existing) existing.push(task)
    else groups.set(key, [task])
  }
  return groups
}

export function planDuplicateMerges<T extends MergeableTask>(
  tasks: readonly T[]
): { tasks: T[]; merges: DuplicateMergeResult<T>[] } {
  const groups = groupOpenTasksBySubject(tasks)

  const merges: DuplicateMergeResult<T>[] = []
  const replacements = new Map<string, T>()
  const removed = new Set<string>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const merge = mergeGroup(group)
    merges.push(merge)
    replacements.set(merge.task.id, merge.task)
    for (const id of merge.mergedIds) removed.add(id)
  }

  const result: T[] = []
  for (const task of tasks) {
    if (removed.has(task.id)) continue
    result.push(replacements.get(task.id) ?? task)
  }
  return { tasks: result, merges }
}

/**
 * Apply `planDuplicateMerges` to a store directory: persist each survivor, then
 * delete the records folded into it.
 *
 * Order matters and is the opposite of the obvious one. The survivor carries
 * the union of every duplicate's dependency edges, which exists nowhere else
 * once the folded files are gone — so the write has to land first. If it fails,
 * that group is abandoned with all of its records still on disk: a duplicate
 * row is a cosmetic problem, a dropped blocker is a correctness one, and the
 * next pass will retry the merge from an intact population.
 *
 * Deleting a record that is already gone is still fine to ignore; that is
 * convergence, not loss.
 */
/** A task paired with whatever the caller uses to address its owning store. */
export interface AddressedTask<T, A> {
  address: A
  task: T
}

/**
 * Store access for a cross-store merge. Kept as callbacks so this stays a leaf
 * module: the task repository imports it, not the other way round.
 */
export interface StoreAccess<T, A> {
  /** Directory holding the records of the given store. */
  dirFor(address: A): Promise<string> | string
  /** Quiet, durable write of the survivor to its own store. */
  write(address: A, task: T): Promise<void>
}

/**
 * Merge duplicates across several stores at once.
 *
 * This is the case the feature exists for. Each session that ends with unpushed
 * commits leaves one "Push branch to remote" stub in its *own* session store,
 * so every store holds a single copy and a per-directory pass never sees a
 * group. Only the assembled queue does.
 *
 * The survivor stays in the store it came from and the folded records are
 * deleted from theirs, so no record moves between stores.
 */
export async function mergeDuplicateTasksAcrossStores<T extends MergeableTask, A>(
  records: readonly AddressedTask<T, A>[],
  access: StoreAccess<T, A>
): Promise<AddressedTask<T, A>[]> {
  const { merges } = planDuplicateMerges(records.map((record) => record.task))
  if (merges.length === 0) return [...records]

  const addressById = new Map(records.map((record) => [record.task.id, record.address]))
  const folded = new Set<string>()
  const survivors = new Map<string, T>()
  const foldedToSurvivor = new Map<string, string>()

  for (const merge of merges) {
    const address = addressById.get(merge.task.id)
    if (address === undefined) continue
    if (!(await applyCrossStoreMerge(merge, address, addressById, access))) continue
    survivors.set(merge.task.id, merge.task)
    for (const id of merge.mergedIds) {
      folded.add(id)
      foldedToSurvivor.set(id, merge.task.id)
    }
  }

  const result: AddressedTask<T, A>[] = []
  for (const record of records) {
    if (folded.has(record.task.id)) continue
    const survivor = survivors.get(record.task.id)
    result.push(survivor ? { ...record, task: survivor } : record)
  }
  return repointExternalRefs(result, foldedToSurvivor, access)
}

/**
 * Rewrite dependency edges that pointed at a folded record so they point at its
 * survivor.
 *
 * Without this a merge silently unblocks work: `openBlockersOf` drops any
 * blocker id it cannot resolve, so a task blocked by a duplicate that was just
 * folded away reads as ready while the survivor is still open. Edges inside a
 * merged group are handled by `unionRefs`; these are the edges held by everyone
 * else.
 */
async function repointExternalRefs<T extends MergeableTask, A>(
  records: readonly AddressedTask<T, A>[],
  foldedToSurvivor: ReadonlyMap<string, string>,
  access: StoreAccess<T, A>
): Promise<AddressedTask<T, A>[]> {
  if (foldedToSurvivor.size === 0) return [...records]

  const result: AddressedTask<T, A>[] = []
  for (const record of records) {
    const blocks = remapRefs(record.task.id, record.task.blocks, foldedToSurvivor)
    const blockedBy = remapRefs(record.task.id, record.task.blockedBy, foldedToSurvivor)
    if (!blocks && !blockedBy) {
      result.push(record)
      continue
    }

    const task = {
      ...record.task,
      ...(blocks ? { blocks } : {}),
      ...(blockedBy ? { blockedBy } : {}),
    }
    try {
      await access.write(record.address, task)
      result.push({ ...record, task })
    } catch {
      // Edge repointing failed to persist; keep the record as read so the
      // in-memory view does not claim a durable state it does not have.
      result.push(record)
    }
  }
  return result
}

/** Returns the rewritten list, or null when nothing referenced a folded id. */
function remapRefs(
  ownerId: string,
  refs: readonly string[] | undefined,
  foldedToSurvivor: ReadonlyMap<string, string>
): string[] | null {
  if (!refs || refs.length === 0) return null
  if (!refs.some((ref) => foldedToSurvivor.has(ref))) return null

  const seen = new Set<string>()
  for (const ref of refs) {
    const target = foldedToSurvivor.get(ref) ?? ref
    // Collapsing a group can make an edge point at its own holder.
    if (target !== ownerId) seen.add(target)
  }
  return [...seen]
}

/** Survivor-first, same ordering guarantee as the single-store path. */
async function applyCrossStoreMerge<T extends MergeableTask, A>(
  merge: DuplicateMergeResult<T>,
  survivorAddress: A,
  addressById: ReadonlyMap<string, A>,
  access: StoreAccess<T, A>
): Promise<boolean> {
  const targets: string[] = []
  for (const id of merge.mergedIds) {
    const address = addressById.get(id)
    if (address === undefined) return false
    const path = resolveTaskFilePath(await access.dirFor(address), id)
    if (path === null) return false
    targets.push(path)
  }

  try {
    await access.write(survivorAddress, merge.task)
  } catch {
    return false
  }

  for (const path of targets) {
    try {
      await unlink(path)
    } catch {
      // already gone — the survivor covers this work either way
    }
  }
  return true
}

/**
 * Persist one survivor and remove its folded records. Returns false when the
 * group was left untouched, so the caller keeps every original in its result.
 */
async function applyMerge<T extends MergeableTask>(
  dir: string,
  merge: DuplicateMergeResult<T>,
  writeSurvivor?: (task: T) => Promise<void>
): Promise<boolean> {
  // A record whose id cannot be turned into a path inside `dir` is corrupt.
  // Leave the whole group alone rather than half-merge it.
  const paths: string[] = []
  for (const id of merge.mergedIds) {
    const path = resolveTaskFilePath(dir, id)
    if (path === null) return false
    paths.push(path)
  }

  if (writeSurvivor) {
    try {
      await writeSurvivor(merge.task)
    } catch {
      // Survivor not durable — keep every original record and retry later.
      return false
    }
  }

  for (const path of paths) {
    try {
      await unlink(path)
    } catch {
      // already gone — the survivor covers this work either way
    }
  }
  return true
}

export async function mergeDuplicateTaskFiles<T extends MergeableTask>(
  dir: string,
  tasks: readonly T[],
  writeSurvivor?: (task: T) => Promise<void>
): Promise<T[]> {
  const { merges } = planDuplicateMerges(tasks)
  if (merges.length === 0) return [...tasks]

  const folded = new Set<string>()
  const survivors = new Map<string, T>()
  for (const merge of merges) {
    if (!(await applyMerge(dir, merge, writeSurvivor))) continue
    survivors.set(merge.task.id, merge.task)
    for (const id of merge.mergedIds) folded.add(id)
  }

  const result: T[] = []
  for (const task of tasks) {
    if (folded.has(task.id)) continue
    result.push(survivors.get(task.id) ?? task)
  }
  return result
}
