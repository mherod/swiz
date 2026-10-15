import { type Deadline, deadlineGuidance, renderDeadline } from "../deadlines/model.ts"
import { DeadlineStore, deadlineSessionKey } from "../deadlines/store.ts"
import { readTaskStore } from "../tasks/task-repository.ts"

const EVENTS = new Set(["preToolUse", "postToolUse", "postToolUseFailure"])
export const DEADLINE_CONTEXT_MARKER = "[Swiz deadline clock]"

export function hasDeadlineContext(response: Record<string, any>): boolean {
  return String(
    response.hookSpecificOutput?.additionalContext ?? response.systemMessage ?? ""
  ).includes(DEADLINE_CONTEXT_MARKER)
}

/** Read task state from its original provider/store, never from the daemon's ambient agent. */
async function taskStillOpen(deadline: Deadline): Promise<boolean> {
  if (!deadline.task) return false
  const { storeKey, taskId, tasksDir } = deadline.task
  const task = (await readTaskStore(storeKey, tasksDir)).find((item) => item.id === taskId)
  // Missing task data is not completion evidence: retain the reminder until explicitly closed.
  return !task || task.status === "pending" || task.status === "in_progress"
}

function requestedWait(payload: Record<string, unknown>): number | null {
  const name = String(payload.tool_name ?? payload.toolName ?? "")
  if (!/wait|sleep/i.test(name)) return null
  const input = payload.tool_input ?? payload.toolInput
  if (!input || typeof input !== "object") return null
  const args = input as Record<string, unknown>
  const value = ["duration_ms", "waitMs", "timeoutMs", "timeout_ms", "yield_time_ms"]
    .map((key) => args[key])
    .find((value) => value !== undefined)
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null
}

async function readActiveDeadlines(
  payload: Record<string, unknown>,
  path?: string
): Promise<Deadline[]> {
  const sessionId = payload.session_id
  const cwd = payload.cwd
  if (typeof sessionId !== "string" || !sessionId || typeof cwd !== "string" || !cwd) return []
  const agentId = typeof payload.agent_id === "string" ? payload.agent_id : undefined
  const store = await DeadlineStore.open(path)
  if (!store) return []
  try {
    return store
      .list(deadlineSessionKey(cwd, sessionId, agentId))
      .filter((item) => item.status === "active")
  } finally {
    store.close()
  }
}

async function selectDeadlines(active: Deadline[]): Promise<Deadline[]> {
  const delivery = active.find((item) => item.kind === "delivery")
  let task: Deadline | undefined
  for (const item of active) {
    if (item.kind === "task" && (await taskStillOpen(item))) {
      task = item
      break
    }
  }
  return [delivery, task].filter((item): item is Deadline => !!item)
}

async function buildDeadlineContext(
  payload: Record<string, unknown>,
  canonicalEvent: string,
  now: number,
  path?: string
): Promise<string | null> {
  const selected = await selectDeadlines(await readActiveDeadlines(payload, path))
  if (!selected.length) return null
  const delivery = selected.find((item) => item.kind === "delivery")
  const earliest = [...selected].sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0]!
  const wait = canonicalEvent === "preToolUse" ? requestedWait(payload) : null
  const lines = [
    `${DEADLINE_CONTEXT_MARKER} ${canonicalEvent}; now ${new Date(now).toISOString()}.`,
    ...selected.map((item) => renderDeadline(item, now)),
    deadlineGuidance(earliest, now),
  ]
  if (delivery)
    lines.push(
      `Delivery requires: ${delivery.completionCriteria.replace(/\s+/g, " ").slice(0, 240)}`
    )
  if (wait !== null && wait > Math.max(0, Date.parse(earliest.dueAt) - now)) {
    lines.push(
      "The requested wait allowance exceeds the remaining time. Consider a shorter check; the tool arguments are unchanged."
    )
  }
  return lines.join("\n")
}

/** Append after humanisation, including empty responses. Advisory errors never deny a tool. */
export async function injectDeadlineContext(
  response: Record<string, any>,
  canonicalEvent: string,
  hookEventName: string,
  payload: Record<string, unknown>,
  options: { now?: number; path?: string } = {}
): Promise<boolean> {
  if (!EVENTS.has(canonicalEvent) || response.error) return false
  let context: string | null
  try {
    context = await buildDeadlineContext(
      payload,
      canonicalEvent,
      options.now ?? Date.now(),
      options.path
    )
  } catch {
    context = `${DEADLINE_CONTEXT_MARKER} Deadline state unavailable; do not infer time remaining. Tool execution is unaffected.`
  }
  if (!context) return false
  const append = (existing: unknown) =>
    [typeof existing === "string" ? existing.trim() : "", context].filter(Boolean).join("\n\n")
  response.hookSpecificOutput ??= { hookEventName }
  response.hookSpecificOutput.additionalContext = append(
    response.hookSpecificOutput.additionalContext
  )
  response.systemMessage = append(response.systemMessage)
  return true
}

export async function injectDeadlinePayloadContext(
  response: Record<string, any>,
  canonicalEvent: string,
  hookEventName: string,
  payloadStr: string
): Promise<void> {
  try {
    await injectDeadlineContext(response, canonicalEvent, hookEventName, JSON.parse(payloadStr))
  } catch {
    /* Malformed input belongs to dispatch validation; decoration is fail-open. */
  }
}
