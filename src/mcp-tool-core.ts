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
import { dirname, join } from "node:path"
import { z } from "zod"
import { getHomeDirWithFallback } from "./home.ts"
import { projectKeyFromCwd } from "./project-key.ts"
import { createDefaultTaskStore } from "./task-roots.ts"
import { getTaskToolName } from "./tasks/task-governance-messages.ts"
import {
  describeTaskChanges,
  findNewlyUnblockedTasks,
  MAX_LISTED_PER_GROUP,
  renderTaskToolResult,
  renderUnblockedLine,
  truncateForLine,
} from "./tasks/task-mcp-view.ts"
import { pruneStaleCompletedTasks } from "./tasks/task-prune.ts"
import { isSafeSessionId, readTasks, type Task } from "./tasks/task-repository.ts"
import {
  completeTaskWithAutoTransition,
  createTaskInProcess,
  updateStatus,
  writeTaskUpdate,
} from "./tasks/task-service.ts"
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
}

export const MCP_TOOL_NAMES = ["reply", "TaskCreate", "TaskUpdate", "TaskList"] as const
export const mcpToolNameSchema = z.enum(MCP_TOOL_NAMES)
export type McpToolName = z.infer<typeof mcpToolNameSchema>

/** Loose bag of tool arguments; each tool validates its own required fields. */
export const mcpToolInputSchema = z.looseObject({})
export type McpToolInput = z.infer<typeof mcpToolInputSchema>

export const mcpToolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  isError: z.boolean().optional(),
})

function textResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }] }
}

function errorResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true }
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
 * age (COMPLETED_TASK_PRUNE_AGE_MS). The MCP task tools are the one surface
 * allowed to prune this store: a task mutation or query here is an explicit
 * agent action. Passive read paths must stay non-destructive — the daemon
 * status line once deleted the tasks it was counting (see
 * readProjectStoreTasks in compliance-routes.ts).
 */
export async function readProjectTasksWithPrune(
  projectKey: string,
  tasksDir = createDefaultTaskStore().tasksDir
): Promise<Task[]> {
  const tasks = await readTasks(projectKey, tasksDir)
  if (!isSafeSessionId(projectKey, tasksDir)) return tasks
  return pruneStaleCompletedTasks(join(tasksDir, projectKey), tasks)
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
      subject: input.subject,
      description: input.description,
      ...(typeof input.activeForm === "string" ? { activeForm: input.activeForm } : {}),
      cwd,
    })
    const tasks = await readProjectTasksWithPrune(projectKey)
    const headline = `Created #${task.id} — ${truncateForLine(task.subject)}`
    return textResult(renderTaskToolResult(headline, tasks, task.id))
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
    task.blocks = [...new Set([...task.blocks, ...input.addBlocks])]
    changes.push(`blocks +#${input.addBlocks.join(", #")}`)
  }
  if (input.removeBlocks) {
    task.blocks = task.blocks.filter((id) => !input.removeBlocks!.includes(id))
    changes.push(`blocks -#${input.removeBlocks.join(", #")}`)
  }
  if (input.addBlockedBy) {
    task.blockedBy = [...new Set([...task.blockedBy, ...input.addBlockedBy])]
    changes.push(`blockedBy +#${input.addBlockedBy.join(", #")}`)
  }
  if (input.removeBlockedBy) {
    task.blockedBy = task.blockedBy.filter((id) => !input.removeBlockedBy!.includes(id))
    changes.push(`blockedBy -#${input.removeBlockedBy.join(", #")}`)
  }
  return changes
}

async function persistTaskUpdate(
  projectKey: string,
  cwd: string,
  task: Task,
  input: TaskUpdateToolInput,
  fieldsUpdated: boolean
): Promise<void> {
  if (input.status === undefined || input.status === task.status) {
    if (fieldsUpdated) await writeTaskUpdate(projectKey, input.taskId, task)
    return
  }
  if (fieldsUpdated) await writeTaskUpdate(projectKey, input.taskId, task)
  if (input.status === "completed") {
    await completeTaskWithAutoTransition(projectKey, input.taskId, {
      filterCwd: cwd,
      evidence: input.description,
    })
  } else {
    await updateStatus(projectKey, input.taskId, input.status, { filterCwd: cwd })
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
    const tasksBefore = await readProjectTasksWithPrune(projectKey)
    const task = tasksBefore.find((candidate) => candidate.id === input.taskId)
    if (!task) {
      return errorResult(renderUnknownTaskId(taskUpdateName, input.taskId, tasksBefore))
    }
    const previousStatus = task.status
    // Snapshot before applyTaskFieldUpdates mutates `task` in place, so the unblock comparison
    // sees the pre-update blockedBy edges rather than the ones this call just wrote.
    const snapshotBefore = tasksBefore.map((candidate) => ({
      ...candidate,
      blockedBy: [...candidate.blockedBy],
    }))
    const fieldChanges = applyTaskFieldUpdates(task, input)
    await persistTaskUpdate(projectKey, cwd, task, input, fieldChanges.length > 0)
    const tasksAfter = await readTasks(projectKey)
    const finalTask = tasksAfter.find((candidate) => candidate.id === input.taskId)
    const headline = buildUpdateHeadline(
      input.taskId,
      finalTask?.subject ?? task.subject,
      previousStatus,
      input,
      fieldChanges
    )
    const unblocked = renderUnblockedLine(findNewlyUnblockedTasks(snapshotBefore, tasksAfter))
    const fullHeadline = unblocked ? `${headline}\n${unblocked}` : headline
    return textResult(renderTaskToolResult(fullHeadline, tasksAfter, input.taskId))
  } catch (error) {
    return errorResult(`${taskUpdateName} failed: ${messageFromUnknownError(error)}`)
  }
}

// ─── TaskList ───────────────────────────────────────────────────────────────

async function runTaskListTool(cwd: string): Promise<McpToolResult> {
  try {
    const allTasks = await readProjectTasksWithPrune(projectKeyFromCwd(cwd))
    const headline =
      allTasks.length === 0 ? "No tasks in this project yet." : "Task queue for this project."
    return textResult(renderTaskToolResult(headline, allTasks))
  } catch (error) {
    return errorResult(`TaskList failed: ${messageFromUnknownError(error)}`)
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
  }
}
