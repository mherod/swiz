/** Address-preserving, read-only projections shared by MCP and task governance. */
import { type StoredTask, type Task, taskRecordReference } from "./task-repository.ts"
import { taskStoreDirName } from "./task-store-path.ts"

export type QueueTask = Task & { ownership: string; storeKey: StoredTask["storeKey"] }

export const TASK_QUEUE_RECOVERY =
  "Use TaskList to inspect the project queue. Use the full taskId shown for an ambiguous ID " +
  "with the project MCP TaskUpdate tool. For a native session, use TaskUpdate in that owning " +
  "session or coordinate with its owner. Complete work with evidence; cancel only work you " +
  "own that is no longer needed."

export function taskOwnershipSuffix(task: { ownership?: string }): string {
  return task.ownership ? ` [${task.ownership}]` : ""
}

/** Qualify only colliding IDs; ordinary task IDs and their dependency edges remain familiar. */
export function projectQueueTasks(records: readonly StoredTask[]): QueueTask[] {
  const byId = new Map<string, StoredTask[]>()
  for (const record of records) {
    const matches = byId.get(record.task.id) ?? []
    matches.push(record)
    byId.set(record.task.id, matches)
  }
  const reference = (record: StoredTask) =>
    (byId.get(record.task.id)?.length ?? 0) > 1 ? taskRecordReference(record) : record.task.id
  const byReference = new Map(records.map((record) => [taskRecordReference(record), record]))
  return records.map((record) => {
    const edge = (id: string) => {
      const explicit = byReference.get(id)
      if (explicit) return [reference(explicit)]
      const candidates = byId.get(id) ?? []
      const own = candidates.find(
        (candidate) => taskStoreDirName(candidate.storeKey) === taskStoreDirName(record.storeKey)
      )
      if (own) return [reference(own)]
      // An ambiguous external edge must not silently unblock its dependent.
      return candidates.length ? candidates.map(reference) : [id]
    }
    return {
      ...record.task,
      id: reference(record),
      blocks: record.task.blocks.flatMap(edge),
      blockedBy: record.task.blockedBy.flatMap(edge),
      storeKey: record.storeKey,
      ownership:
        taskRecordReference(record) +
        (record.queueScope === "current-session"
          ? "; explicit current session, outside MCP project scope"
          : ""),
    }
  })
}

export function resolveQueueTask(
  records: readonly StoredTask[],
  reference: string
): StoredTask | undefined {
  const matches = records.filter(
    (record) => record.task.id === reference || taskRecordReference(record) === reference
  )
  if (matches.length > 1) {
    throw new Error(
      `Task #${reference} is ambiguous. Use a full taskId: ${matches.map(taskRecordReference).join(", ")}.`
    )
  }
  return matches[0]
}
