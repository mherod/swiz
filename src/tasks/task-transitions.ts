// ─── Task state-machine transition rules ─────────────────────────────────────
//
// Single source of truth for valid task status transitions. Both task-service.ts
// and task-event-state.ts import from here; this module has no intra-task
// imports so it cannot participate in any circular dependency.

/**
 * Valid outgoing transitions for each task status.
 * completed can be reopened when follow-up work is discovered.
 */
export const VALID_TRANSITIONS: Record<string, Set<string>> = {
  pending: new Set(["in_progress", "cancelled"]),
  in_progress: new Set(["completed", "cancelled"]),
  completed: new Set(["in_progress"]),
  cancelled: new Set(["pending", "in_progress"]),
}

/**
 * Check whether a status transition is valid. Returns true for same-status
 * no-ops, false when the transition violates the state machine.
 */
export function isValidTransition(oldStatus: string, newStatus: string): boolean {
  if (oldStatus === newStatus) return true
  return VALID_TRANSITIONS[oldStatus]?.has(newStatus) ?? false
}

/**
 * Returns null when the transition is valid, or an error string when it is not.
 */
export function validateTransition(oldStatus: string, newStatus: string): string | null {
  if (oldStatus === newStatus) return null
  const allowed = VALID_TRANSITIONS[oldStatus]
  if (!allowed || !allowed.has(newStatus)) {
    return `Invalid transition: ${oldStatus} → ${newStatus}. Tasks must be in_progress before they can be completed.`
  }
  return null
}

/**
 * Compute the shortest path of valid intermediate transitions from `oldStatus`
 * to `newStatus`. Returns the steps excluding `oldStatus` but including
 * `newStatus`, or null if no valid path exists (max depth 3).
 *
 * Examples:
 *   computeTransitionPath("pending", "completed")  → ["in_progress", "completed"]
 *   computeTransitionPath("pending", "in_progress") → ["in_progress"]
 *   computeTransitionPath("completed", "in_progress") → ["in_progress"]
 */
export function computeTransitionPath(oldStatus: string, newStatus: string): string[] | null {
  if (oldStatus === newStatus) return []
  if (isValidTransition(oldStatus, newStatus)) return [newStatus]

  // BFS over valid transitions (max depth 3 — graph has 4 nodes)
  const queue: Array<{ status: string; path: string[] }> = [{ status: oldStatus, path: [] }]
  const visited = new Set<string>([oldStatus])

  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.path.length >= 3) continue

    const allowed = VALID_TRANSITIONS[current.status]
    if (!allowed) continue

    for (const next of allowed) {
      if (visited.has(next)) continue
      const newPath = [...current.path, next]
      if (next === newStatus) return newPath
      visited.add(next)
      queue.push({ status: next, path: newPath })
    }
  }
  return null
}
