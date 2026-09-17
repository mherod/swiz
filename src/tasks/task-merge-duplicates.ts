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
import { join } from "node:path"
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
 * Apply `planDuplicateMerges` to a store directory: delete the folded-in task
 * files and persist each survivor through `writeSurvivor`. Fail-open, matching
 * the pruning pass — a deletion error still drops the record from the returned
 * list, because the survivor already represents that work.
 */
export async function mergeDuplicateTaskFiles<T extends MergeableTask>(
  dir: string,
  tasks: readonly T[],
  writeSurvivor?: (task: T) => Promise<void>
): Promise<T[]> {
  const { tasks: merged, merges } = planDuplicateMerges(tasks)
  if (merges.length === 0) return [...tasks]

  for (const merge of merges) {
    for (const id of merge.mergedIds) {
      try {
        await unlink(join(dir, `${id}.json`))
      } catch {
        // already gone or locked — the survivor still covers this work
      }
    }
    if (writeSurvivor) {
      try {
        await writeSurvivor(merge.task)
      } catch {
        // the in-memory result stays correct even if persistence fails
      }
    }
  }
  return merged
}
