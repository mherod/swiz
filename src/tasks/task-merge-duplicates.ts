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
  /** Quiet, durable write of a survivor or dependent to its own store. */
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
 * All survivor and reference writes must finish before any deletion. A failed
 * write leaves the original population available for retry; successful writes
 * remain safe because both the original and replacement IDs still resolve.
 */
export async function mergeDuplicateTasksAcrossStores<T extends MergeableTask, A>(
  records: readonly AddressedTask<T, A>[],
  access: StoreAccess<T, A>
): Promise<AddressedTask<T, A>[]> {
  // Legacy session-local IDs cannot address a cross-store merge unambiguously.
  // Preserve the full queue until an owner selects the records explicitly.
  if (new Set(records.map((record) => record.task.id)).size !== records.length) return [...records]
  const plan = await planCrossStoreMerge(records, access)
  const persisted = new Map<string, AddressedTask<T, A>>()
  try {
    for (const record of plan.writes) {
      await access.write(record.address, record.task)
      persisted.set(record.task.id, record)
    }
  } catch {
    // Reflect confirmed writes, but keep every folded record in the queue and
    // on disk. No dangling blocker is introduced, even across linked groups.
    return records.map((record) => persisted.get(record.task.id) ?? record)
  }
  await deleteFoldedTaskFiles(plan.targets)
  return plan.records
}

/** Prepare all durable changes before applying any of them. */
async function planCrossStoreMerge<T extends MergeableTask, A>(
  records: readonly AddressedTask<T, A>[],
  access: StoreAccess<T, A>
): Promise<{
  records: AddressedTask<T, A>[]
  writes: AddressedTask<T, A>[]
  targets: string[]
}> {
  const { merges } = planDuplicateMerges(records.map((record) => record.task))
  const addressById = new Map(records.map((record) => [record.task.id, record.address]))
  // Map insertion order keeps survivor writes ahead of external dependents.
  const writes = new Map<string, AddressedTask<T, A>>()
  const foldedToSurvivor = new Map<string, string>()
  const targets: string[] = []

  for (const merge of merges) {
    const address = addressById.get(merge.task.id)
    if (address === undefined) continue
    const paths = await resolveMergeTargets(merge.mergedIds, addressById, access)
    if (paths === null) continue
    targets.push(...paths)
    writes.set(merge.task.id, { address, task: merge.task })
    for (const id of merge.mergedIds) foldedToSurvivor.set(id, merge.task.id)
  }

  const result: AddressedTask<T, A>[] = []
  for (const record of records) {
    if (foldedToSurvivor.has(record.task.id)) continue
    const proposed = writes.get(record.task.id) ?? record
    const task = repointTaskRefs(proposed.task, foldedToSurvivor)
    const updated = task === proposed.task ? proposed : { ...proposed, task }
    if (updated !== record) writes.set(task.id, updated)
    result.push(updated)
  }
  return { records: result, writes: [...writes.values()], targets }
}

/**
 * Rewrite dependency edges that pointed at a folded record so they point at its
 * survivor.
 *
 * Without this a merge silently unblocks work: `openBlockersOf` drops any
 * blocker id it cannot resolve, so a task blocked by a duplicate that was just
 * folded away reads as ready while the survivor is still open. Edges inside a
 * merged group are handled by `unionRefs`; this also repoints edges between
 * different groups before their survivors are persisted.
 */
function repointTaskRefs<T extends MergeableTask>(
  task: T,
  foldedToSurvivor: ReadonlyMap<string, string>
): T {
  const blocks = remapRefs(task.id, task.blocks, foldedToSurvivor)
  const blockedBy = remapRefs(task.id, task.blockedBy, foldedToSurvivor)
  if (!blocks && !blockedBy) return task
  return {
    ...task,
    ...(blocks ? { blocks } : {}),
    ...(blockedBy ? { blockedBy } : {}),
  }
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

/** Reject a corrupt group before any of its records are rewritten or deleted. */
async function resolveMergeTargets<T, A>(
  mergedIds: readonly string[],
  addressById: ReadonlyMap<string, A>,
  access: StoreAccess<T, A>
): Promise<string[] | null> {
  const targets: string[] = []
  for (const id of mergedIds) {
    const address = addressById.get(id)
    if (address === undefined) return null
    const path = resolveTaskFilePath(await access.dirFor(address), id)
    if (path === null) return null
    targets.push(path)
  }
  return targets
}

/** Called only after the corresponding required writes have succeeded. */
async function deleteFoldedTaskFiles(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      await unlink(path)
    } catch {
      // already gone — the survivor covers this work either way
    }
  }
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

  await deleteFoldedTaskFiles(paths)
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
