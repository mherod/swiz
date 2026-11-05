/**
 * Which queued tasks the current agent session owns.
 *
 * The shared project store records no creating session, so a session's claim on
 * one of its rows has to come from the session's own transcript. A claim is a
 * create (or a dedupe recovery) or a real status transition. A description-only
 * note is not: those are exactly what a session writes onto rows it does not
 * own when a governance gate asks it to bring the queue current, and counting
 * them would let any onlooker keep a dead row alive (the renewal loop on
 * plugg-platform #0e3a-2714/2762/2941, re-noted hourly by a non-owner).
 *
 * Leaf module: node builtins only, so dispatch-loaded hooks can import it.
 */

import type { TaskStoreKey } from "./task-store-path.ts"

const TASK_ID = "([A-Za-z0-9][\\w-]*)"
const STATUS = "(?:pending|in_progress|completed|cancelled)"
/** `Created #id`, `Recovered #id` (MCP), or `Task #id created` (native). */
const CREATE_RESULT_RE = new RegExp(
  `(?:\\b(?:Created|Recovered) #${TASK_ID}|\\bTask #${TASK_ID} created)`,
  "g"
)
/** `Updated #id — subject (old → new` — only a real transition prints the arrow pair. */
const STATUS_CHANGE_RESULT_RE = new RegExp(
  `\\bUpdated #${TASK_ID} — [^\\n]*?\\(${STATUS} → ${STATUS}`,
  "g"
)
const TASK_CREATE_TOOL_RE = /(?:^|__)TaskCreate$/
const TASK_UPDATE_TOOL_RE = /(?:^|__)TaskUpdate$/

/** Bare task id from a raw id, `#id`, or a qualified `kind:key#id` reference. */
export function bareTaskId(reference: string): string {
  const hash = reference.lastIndexOf("#")
  return hash === -1 ? reference : reference.slice(hash + 1)
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : ""
    )
    .join("\n")
}

function addMatches(text: string, re: RegExp, owned: Set<string>): void {
  for (const match of text.matchAll(re)) {
    const id = match[1] ?? match[2]
    if (id) owned.add(id)
  }
}

interface ContentBlock {
  type?: string
  id?: string
  name?: string
  tool_use_id?: string
  content?: unknown
}

function contentBlocks(line: string): ContentBlock[] {
  try {
    const entry = JSON.parse(line) as { message?: { content?: unknown } }
    const content = entry?.message?.content
    return Array.isArray(content) ? (content as ContentBlock[]) : []
  } catch {
    return []
  }
}

type TaskToolKind = "create" | "update"

function taskToolKind(name: string): TaskToolKind | null {
  if (TASK_CREATE_TOOL_RE.test(name)) return "create"
  if (TASK_UPDATE_TOOL_RE.test(name)) return "update"
  return null
}

/** Record a task tool call, or harvest the claimed ids from its result. */
function visitBlock(
  block: ContentBlock,
  taskToolById: Map<string, TaskToolKind>,
  owned: Set<string>
): void {
  if (block.type === "tool_use" && block.id && block.name) {
    const kind = taskToolKind(block.name)
    if (kind) taskToolById.set(block.id, kind)
    return
  }
  if (block.type !== "tool_result" || !block.tool_use_id) return
  const kind = taskToolById.get(block.tool_use_id)
  if (!kind) return
  addMatches(
    resultText(block.content),
    kind === "create" ? CREATE_RESULT_RE : STATUS_CHANGE_RESULT_RE,
    owned
  )
}

/** Task ids this transcript's session created or moved through a status transition. */
export function collectSessionOwnedTaskIds(lines: Iterable<string>): Set<string> {
  const taskToolById = new Map<string, TaskToolKind>()
  const owned = new Set<string>()
  for (const line of lines) {
    // Results carry no tool name ("Created #id"), so prefilter on the block types only.
    if (!line.includes('"tool_')) continue
    for (const block of contentBlocks(line)) visitBlock(block, taskToolById, owned)
  }
  return owned
}

/** Read a transcript's owned task ids; an unreadable transcript owns nothing. */
export async function readSessionOwnedTaskIds(
  transcriptPath: string | undefined
): Promise<Set<string>> {
  if (!transcriptPath) return new Set()
  try {
    const text = await Bun.file(transcriptPath).text()
    return collectSessionOwnedTaskIds(text.split("\n"))
  } catch {
    return new Set()
  }
}

/**
 * Whether the current session owns a queued task. A session store belongs to the
 * session it is named for; a project-store row needs transcript evidence.
 */
export function isTaskOwnedBySession(
  task: { id: string; storeKey?: TaskStoreKey },
  sessionId: string,
  ownedIds: ReadonlySet<string>
): boolean {
  const key = task.storeKey
  if (!key) return true
  if (key.kind === "session") return key.id === sessionId
  return ownedIds.has(bareTaskId(task.id))
}
