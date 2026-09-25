/**
 * Swiz MCP tool core — the business logic behind the MCP task/reply tools.
 *
 * Lives outside src/commands/mcp.ts so two callers can share it:
 *   - the daemon's POST /mcp/tool route (src/commands/daemon/mcp-tool-routes.ts),
 *     which executes current code because lefthook restarts the daemon on every
 *     commit; and
 *   - the `swiz mcp` stdio server's local fallback, used when the daemon is
 *     unreachable.
 *
 * The stdio server is a long-lived process bound to the agent session, so code
 * loaded at its start goes stale across commits — mirroring dispatch.ts, it
 * forwards here via the daemon first and only executes in-process as a fallback.
 */

import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { getHomeDirWithFallback } from "./home.ts"
import { projectKeyFromCwd } from "./project-key.ts"
import {
  querySkills,
  renderSkillQuery,
  type SkillQueryResult,
  skillQueryResultSchema,
} from "./skill-query.ts"
import { createDefaultTaskStore } from "./task-roots.ts"
import { discoverRelatedTaskAdvice } from "./tasks/task-discovery.ts"
import { getTaskToolName } from "./tasks/task-governance-messages.ts"
import {
  describeTaskChanges,
  findNewlyUnblockedTasks,
  MAX_LISTED_PER_GROUP,
  renderTaskToolResult,
  renderUnblockedLine,
  truncateForLine,
} from "./tasks/task-mcp-view.ts"
import { mergeDuplicateTasksAcrossStores } from "./tasks/task-merge-duplicates.ts"
import { pruneStaleCompletedTasks } from "./tasks/task-prune.ts"
import { projectQueueTasks, resolveQueueTask } from "./tasks/task-queue-view.ts"
import {
  isSafeSessionId,
  projectStoreKey,
  readTaskRecordsAcrossStores,
  readTaskStore,
  refreshSessionMetaFromDisk,
  type StoredTask,
  type Task,
  type TaskStoreKey,
  writeTask,
} from "./tasks/task-repository.ts"
import {
  completeTaskWithAutoTransition,
  createTaskInProcess,
  updateStatus,
  writeTaskUpdate,
} from "./tasks/task-service.ts"
import { readTaskStorePath } from "./tasks/task-store-layout.ts"
import { swizMcpRepliesLogPath } from "./temp-paths.ts"
import { messageFromUnknownError } from "./utils/hook-json-helpers.ts"

// ─── Result shape ───────────────────────────────────────────────────────────

export interface McpToolTextContent {
  type: "text"
  text: string
}

export interface McpToolResult {
  content: McpToolTextContent[]
  isError?: boolean
  structuredContent?: {
    summary?: string
    taskMutation?: { changed: boolean }
    skillQuery?: SkillQueryResult
  }
}

export const MCP_TOOL_NAMES = [
  "reply",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "SkillQuery",
] as const
export const mcpToolNameSchema = z.enum(MCP_TOOL_NAMES)
export type McpToolName = z.infer<typeof mcpToolNameSchema>

/** Loose bag of tool arguments; each tool validates its own required fields. */
export const mcpToolInputSchema = z.looseObject({})
export type McpToolInput = z.infer<typeof mcpToolInputSchema>

export const mcpToolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  isError: z.boolean().optional(),
  structuredContent: z
    .object({
      summary: z.string().optional(),
      taskMutation: z.object({ changed: z.boolean() }).optional(),
      skillQuery: skillQueryResultSchema.optional(),
    })
    .optional(),
})

function textResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }] }
}

function errorResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true }
}

/**
 * Claude Code hands the model a tool's structuredContent in place of its text
 * content, so a mutation result repeats the rendered text as `summary`; without
 * it the model sees only `{"taskMutation":{"changed":true}}` and never learns
 * the created id or the resulting queue.
 */
function taskMutationResult(text: string, changed: boolean): McpToolResult {
  return { ...textResult(text), structuredContent: { summary: text, taskMutation: { changed } } }
}

// ─── Reply sink ─────────────────────────────────────────────────────────────

let replyWriteChain = Promise.resolve()

export async function appendReplyToSink(
  cwd: string,
  payload: { content: string; kind: string },
  home = getHomeDirWithFallback("/tmp")
): Promise<void> {
  const path = swizMcpRepliesLogPath(home)
  await mkdir(dirname(path), { recursive: true })
  const row = `${JSON.stringify({
    ts: Date.now(),
    project_key: projectKeyFromCwd(cwd),
    cwd,
    kind: payload.kind,
    content: payload.content,
  })}\n`
  const queued = replyWriteChain.then(() => appendFile(path, row))
  replyWriteChain = queued.catch(() => {})
  await queued
}

async function runReplyTool(input: McpToolInput, cwd: string): Promise<McpToolResult> {
  if (typeof input.content !== "string") {
    return errorResult("reply failed: content must be a string")
  }
  const kind = typeof input.kind === "string" ? input.kind : "note"
  try {
    await appendReplyToSink(cwd, { content: input.content, kind })
    return textResult("ok")
  } catch (error) {
    return errorResult(`reply failed: ${messageFromUnknownError(error)}`)
  }
}

// ─── Project-store read with pruning ────────────────────────────────────────

/**
 * Read the project-keyed store, deleting completed tasks past the retention
 * age (COMPLETED_TASK_PRUNE_AGE_MS) and collapsing duplicate open tasks that
 * describe the same work. The MCP task tools are the one surface allowed to
 * maintain this store: a task mutation or query here is an explicit agent
 * action. Passive read paths must stay non-destructive — the daemon status
 * line once deleted the tasks it was counting (see readProjectStoreTasks in
 * compliance-routes.ts).
 */
export async function readProjectTasksWithPrune(
  projectKey: string,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<Task[]> {
  const key: TaskStoreKey = { kind: "project", key: projectKey }
  if (!isSafeSessionId(key, tasksDir)) return []
  const tasks = await readTaskStore(key, tasksDir)
  const dir = await readTaskStorePath(key, tasksDir)
  return pruneStaleCompletedTasks(dir, tasks, undefined, undefined, () =>
    refreshSessionMetaFromDisk(dir, "project")
  )
}

/**
 * Prune project-owned files, then collapse duplicates across the whole
 * assembled queue.
 *
 * Order is the point. The duplicates worth merging are one hook stub per prior
 * session, each alone in its own session store, so merging before the union
 * sees a group of one everywhere and collapses nothing. Only after
 * `readMcpTaskQueue` unions the project store with the affiliated session
 * stores do the copies sit side by side.
 */
async function readProjectQueueWithPrune(
  projectKey: string,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<StoredTask[]> {
  await readProjectTasksWithPrune(projectKey, tasksDir)
  const records = await readMcpTaskQueue(projectKey, tasksDir)
  const merged = await mergeDuplicateTasksAcrossStores(
    records.map(({ storeKey, task }) => ({ address: storeKey, task })),
    {
      dirFor: (storeKey) => readTaskStorePath(storeKey, tasksDir),
      // Queue maintenance persists merged dependencies without a user status transition.
      write: (storeKey, task) => writeTask(storeKey, task, undefined, tasksDir),
    }
  )
  return merged.map(({ address, task }) => ({ storeKey: address, task }))
}

/** Read-only MCP projection, also used by the scope diagnostic without invoking retention. */
export function readMcpTaskQueue(projectKey: string, tasksDir?: string): Promise<StoredTask[]> {
  return readTaskRecordsAcrossStores(undefined, projectKey, tasksDir)
}

// ─── TaskCreate ─────────────────────────────────────────────────────────────

async function runTaskCreateTool(input: McpToolInput, cwd: string): Promise<McpToolResult> {
  const name = getTaskToolName("TaskCreate")
  if (typeof input.subject !== "string" || typeof input.description !== "string") {
    return errorResult(`${name} failed: subject and description must be strings`)
  }
  try {
    const projectKey = projectKeyFromCwd(cwd)
    const task = await createTaskInProcess({
      sessionId: projectKey,
      storeKey: projectStoreKey(cwd),
      subject: input.subject,
      description: input.description,
      ...(typeof input.activeForm === "string" ? { activeForm: input.activeForm } : {}),
      cwd,
    })
    const tasks = projectQueueTasks(await readProjectQueueWithPrune(projectKey))
    const headline = `Created #${task.id} — ${truncateForLine(task.subject)}`
    const advice = await discoverRelatedTaskAdvice(cwd, task)
    return taskMutationResult(renderTaskToolResult(headline, tasks, task.id) + advice, true)
  } catch (error) {
    return errorResult(`${name} failed: ${messageFromUnknownError(error)}`)
  }
}

// ─── TaskUpdate ─────────────────────────────────────────────────────────────

export type TaskUpdateToolInput = {
  taskId: string
  status?: "pending" | "in_progress" | "completed" | "cancelled"
  subject?: string
  description?: string
  addBlocks?: string[]
  removeBlocks?: string[]
  addBlockedBy?: string[]
  removeBlockedBy?: string[]
}

/**
 * Strip the rendered "#" prefix from every id in an edge array and dedupe.
 * The change labels render edges as "blocks +#id", inviting exact copy-back;
 * a raw spread would let "#id" land in the store, where raw-equality removal
 * can never match it again (issue #846 follow-up).
 */
function normalizeTaskIdList(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.replace(/^#/, "")))]
}

/** Remove ids from an edge array, tolerating "#"-prefixed entries on either side. */
function removeTaskIds(edges: readonly string[], remove: readonly string[]): string[] {
  const removeSet = new Set(normalizeTaskIdList(remove))
  return edges.filter((id) => !removeSet.has(id.replace(/^#/, "")))
}

/**
 * Reject field updates that would persist an unreadable or self-contradicting task:
 * readTaskStore drops a record whose subject is empty (the task vanishes), and a
 * self edge is a one-node dependency cycle that can never start.
 */
function invalidFieldUpdateReason(taskId: string, input: TaskUpdateToolInput): string | null {
  if (input.subject !== undefined && !input.subject.trim()) {
    return "subject must not be empty"
  }
  const selfEdges = [...(input.addBlocks ?? []), ...(input.addBlockedBy ?? [])]
  if (normalizeTaskIdList(selfEdges).includes(taskId)) {
    return `task #${taskId} cannot block itself`
  }
  return null
}

/** Apply the non-status fields of an update, returning a label per field actually changed. */
function applyTaskFieldUpdates(task: Task, input: TaskUpdateToolInput): string[] {
  const changes: string[] = []
  if (input.subject !== undefined) {
    task.subject = input.subject
    changes.push("subject")
  }
  if (input.description !== undefined) {
    task.description = input.description
    changes.push("description")
  }
  if (input.addBlocks) {
    const added = normalizeTaskIdList(input.addBlocks)
    task.blocks = [...new Set([...task.blocks, ...added])]
    changes.push(`blocks +#${added.join(", #")}`)
  }
  if (input.removeBlocks) {
    task.blocks = removeTaskIds(task.blocks, input.removeBlocks)
    changes.push(`blocks -#${normalizeTaskIdList(input.removeBlocks).join(", #")}`)
  }
  if (input.addBlockedBy) {
    const added = normalizeTaskIdList(input.addBlockedBy)
    task.blockedBy = [...new Set([...task.blockedBy, ...added])]
    changes.push(`blockedBy +#${added.join(", #")}`)
  }
  if (input.removeBlockedBy) {
    task.blockedBy = removeTaskIds(task.blockedBy, input.removeBlockedBy)
    changes.push(`blockedBy -#${normalizeTaskIdList(input.removeBlockedBy).join(", #")}`)
  }
  return changes
}

async function persistTaskUpdate(
  storeKey: TaskStoreKey,
  cwd: string,
  task: Task,
  input: TaskUpdateToolInput,
  fieldsUpdated: boolean
): Promise<void> {
  // A combined start/field update is one guarded write: a capacity rejection
  // must not leave the subject or description partially changed.
  if (input.status === "in_progress" && task.status !== "in_progress") {
    await writeTaskUpdate(storeKey, task.id, task, input.status, { filterCwd: cwd })
    return
  }
  if (fieldsUpdated)
    await writeTaskUpdate(storeKey, input.taskId, task, undefined, { filterCwd: cwd })
  if (input.status === undefined || input.status === task.status) {
    return
  }
  if (input.status === "completed") {
    await completeTaskWithAutoTransition(storeKey, input.taskId, {
      filterCwd: cwd,
      evidence: input.description,
    })
  } else {
    await updateStatus(storeKey, input.taskId, input.status, { filterCwd: cwd })
  }
}

/** A not-found error names the open tasks, so the caller can retry without a TaskList round trip. */
function renderUnknownTaskId(
  taskUpdateName: string,
  taskId: string,
  tasks: readonly Task[]
): string {
  const open = tasks.filter((task) => task.status === "pending" || task.status === "in_progress")
  if (open.length === 0) {
    return `${taskUpdateName} failed: task ${taskId} not found — this project has no open tasks.`
  }
  const listed = open
    .slice(0, MAX_LISTED_PER_GROUP)
    .map((task) => `#${task.id} ${truncateForLine(task.subject, 40)}`)
    .join(", ")
  const hidden = open.length - Math.min(open.length, MAX_LISTED_PER_GROUP)
  const suffix = hidden > 0 ? ` (+${hidden} more)` : ""
  return `${taskUpdateName} failed: task ${taskId} not found — open tasks: ${listed}${suffix}`
}

function buildUpdateHeadline(
  taskId: string,
  subject: string,
  previousStatus: string,
  input: TaskUpdateToolInput,
  fieldChanges: readonly string[]
): string {
  const parts: string[] = []
  if (input.status !== undefined && input.status !== previousStatus) {
    parts.push(`${previousStatus} → ${input.status}`)
  }
  const fields = describeTaskChanges(fieldChanges)
  if (fields) parts.push(fields)
  const detail = parts.length > 0 ? ` (${parts.join("; ")})` : " (no change)"
  return `Updated #${taskId} — ${truncateForLine(subject)}${detail}`
}

async function runTaskUpdateTool(rawInput: McpToolInput, cwd: string): Promise<McpToolResult> {
  const taskUpdateName = getTaskToolName("TaskUpdate")
  if (typeof rawInput.taskId !== "string") {
    return errorResult(`${taskUpdateName} failed: taskId must be a string`)
  }
  // Every task tool renders ids as "#<id>", so accept that copy-pasted form back (issue #846).
  const input: TaskUpdateToolInput = {
    ...(rawInput as TaskUpdateToolInput),
    taskId: rawInput.taskId.replace(/^#/, ""),
  }
  try {
    const projectKey = projectKeyFromCwd(cwd)
    const records = await readProjectQueueWithPrune(projectKey)
    const tasksBefore = projectQueueTasks(records)
    const record = resolveQueueTask(records, input.taskId)
    if (!record) {
      return errorResult(renderUnknownTaskId(taskUpdateName, input.taskId, tasksBefore))
    }
    const { task, storeKey } = record
    const invalidReason = invalidFieldUpdateReason(task.id, input)
    if (invalidReason) return errorResult(`${taskUpdateName} failed: ${invalidReason}`)
    const previousStatus = task.status
    const movementBefore = taskMovementFields(task)
    // Snapshot before applyTaskFieldUpdates mutates `task` in place, so the unblock comparison
    // sees the pre-update blockedBy edges rather than the ones this call just wrote.
    const snapshotBefore = tasksBefore.map((candidate) => ({
      ...candidate,
      blockedBy: [...candidate.blockedBy],
    }))
    const fieldChanges = applyTaskFieldUpdates(task, input)
    await persistTaskUpdate(
      storeKey,
      cwd,
      task,
      { ...input, taskId: task.id },
      fieldChanges.length > 0
    )
    const recordsAfter = await readMcpTaskQueue(projectKey)
    const tasksAfter = projectQueueTasks(recordsAfter)
    const finalTask = resolveQueueTask(recordsAfter, input.taskId)?.task
    const headline = buildUpdateHeadline(
      input.taskId,
      finalTask?.subject ?? task.subject,
      previousStatus,
      input,
      fieldChanges
    )
    const unblocked = renderUnblockedLine(findNewlyUnblockedTasks(snapshotBefore, tasksAfter))
    const fullHeadline = unblocked ? `${headline}\n${unblocked}` : headline
    return taskMutationResult(
      renderTaskToolResult(fullHeadline, tasksAfter, input.taskId),
      finalTask !== undefined && !isDeepStrictEqual(movementBefore, taskMovementFields(finalTask))
    )
  } catch (error) {
    return errorResult(`${taskUpdateName} failed: ${messageFromUnknownError(error)}`)
  }
}

/** Compare persisted task content, excluding timestamps and edge ordering. */
function taskMovementFields(task: Task): object {
  return {
    status: task.status,
    subject: task.subject,
    description: task.description,
    blocks: [...new Set(task.blocks)].sort(),
    blockedBy: [...new Set(task.blockedBy)].sort(),
  }
}

// ─── TaskList ───────────────────────────────────────────────────────────────

async function runTaskListTool(cwd: string): Promise<McpToolResult> {
  try {
    const allTasks = projectQueueTasks(await readProjectQueueWithPrune(projectKeyFromCwd(cwd)))
    const headline =
      allTasks.length === 0 ? "No tasks in this project yet." : "Task queue for this project."
    return textResult(renderTaskToolResult(headline, allTasks))
  } catch (error) {
    return errorResult(`TaskList failed: ${messageFromUnknownError(error)}`)
  }
}

async function runSkillQueryTool(input: McpToolInput, cwd: string): Promise<McpToolResult> {
  try {
    const result = await querySkills(input, cwd)
    return { ...textResult(renderSkillQuery(result)), structuredContent: { skillQuery: result } }
  } catch (error) {
    return errorResult(`SkillQuery failed: ${messageFromUnknownError(error)}`)
  }
}

// ─── Entry point ────────────────────────────────────────────────────────────

/** Execute one MCP tool call. Shared by the daemon route and the stdio fallback. */
export async function runMcpTool(
  tool: McpToolName,
  input: McpToolInput,
  cwd: string
): Promise<McpToolResult> {
  switch (tool) {
    case "reply":
      return runReplyTool(input, cwd)
    case "TaskCreate":
      return runTaskCreateTool(input, cwd)
    case "TaskUpdate":
      return runTaskUpdateTool(input, cwd)
    case "TaskList":
      return runTaskListTool(cwd)
    case "SkillQuery":
      return runSkillQueryTool(input, cwd)
  }
}
