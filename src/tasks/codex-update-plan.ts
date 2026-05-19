import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { detectCurrentAgentFromHookPayload } from "../agent-paths.ts"
import { getProviderTaskRoots } from "../provider-adapters.ts"
import { computeSubjectFingerprint } from "../subject-fingerprint.ts"
import { extractSessionLines, type TranscriptSummary } from "../transcript-summary.ts"
import { splitJsonlLines, tryParseJsonLine } from "../utils/jsonl.ts"
import { applyTaskListEvent } from "./task-event-state.ts"
import { applyCacheTaskListSnapshot } from "./task-recovery.ts"
import { readTasks, type Task, type TaskStatus, writeAudit, writeTask } from "./task-repository.ts"

const CODEX_UPDATE_PLAN_TOOL_NAMES = new Set(["update_plan", "functions.update_plan"])
const CODEX_PLAN_TASK_ID_PREFIX = "codex-"

const codexPlanStatusSchema = z.enum(["pending", "in_progress", "completed", "cancelled"])
const codexPlanArgumentsSchema = z.looseObject({
  explanation: z.string().optional(),
  plan: z.array(
    z.looseObject({
      step: z.string(),
      status: codexPlanStatusSchema,
    })
  ),
})

export interface CodexUpdatePlanTask {
  step: string
  status: TaskStatus
}

export interface CodexUpdatePlanSnapshot {
  explanation?: string
  plan: CodexUpdatePlanTask[]
  callId?: string
  timestamp?: string
}

export interface CodexUpdatePlanSyncResult {
  snapshots: number
  created: number
  updated: number
  cancelled: number
  unchanged: number
}

interface CodexFunctionCallPayload {
  type?: string
  name?: string
  arguments?: string | Record<string, unknown>
  call_id?: string
}

interface CodexFunctionCallLine {
  timestamp?: string
  payload: CodexFunctionCallPayload
}

function isCodexPlanTaskId(taskId: string): boolean {
  if (!taskId.startsWith(CODEX_PLAN_TASK_ID_PREFIX)) return false
  const seq = Number.parseInt(taskId.slice(CODEX_PLAN_TASK_ID_PREFIX.length), 10)
  return Number.isFinite(seq) && seq > 0
}

function parseCodexPlanArguments(rawArguments: unknown): CodexUpdatePlanTask[] | null {
  let parsed: unknown = rawArguments
  if (typeof rawArguments === "string") {
    try {
      parsed = JSON.parse(rawArguments)
    } catch {
      return null
    }
  }

  const result = codexPlanArgumentsSchema.safeParse(parsed)
  if (!result.success) return null

  const tasks = result.data.plan
    .map((item) => ({ step: item.step.trim(), status: item.status as TaskStatus }))
    .filter((item) => item.step.length > 0)
  return tasks.length > 0 ? tasks : null
}

function parseCodexFunctionCallLine(line: string): CodexFunctionCallLine | null {
  const entry = tryParseJsonLine(line) as
    | {
        timestamp?: string
        type?: string
        payload?: CodexFunctionCallPayload
      }
    | undefined
  const payload = entry?.payload
  if (entry?.type !== "response_item" || payload?.type !== "function_call") return null
  return { payload, ...(entry.timestamp ? { timestamp: entry.timestamp } : {}) }
}

function isCodexUpdatePlanPayload(payload: CodexFunctionCallPayload): boolean {
  return !!payload.name && CODEX_UPDATE_PLAN_TOOL_NAMES.has(payload.name)
}

function parsePlanArgumentsObject(rawArguments: unknown): Record<string, unknown> | null {
  if (typeof rawArguments === "string") {
    try {
      const parsed = JSON.parse(rawArguments) as unknown
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {}
  } else if (rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)) {
    return rawArguments as Record<string, unknown>
  }
  return null
}

function parseCodexPlanExplanation(rawArguments: unknown): string | undefined {
  const parsed = parsePlanArgumentsObject(rawArguments)
  return typeof parsed?.explanation === "string" ? parsed.explanation : undefined
}

function parseCodexPlanSnapshot(line: string): CodexUpdatePlanSnapshot | null {
  const call = parseCodexFunctionCallLine(line)
  if (!call || !isCodexUpdatePlanPayload(call.payload)) return null

  const tasks = parseCodexPlanArguments(call.payload.arguments)
  if (!tasks) return null

  const explanation = parseCodexPlanExplanation(call.payload.arguments)

  return {
    ...(explanation ? { explanation } : {}),
    plan: tasks,
    ...(call.payload.call_id ? { callId: call.payload.call_id } : {}),
    ...(call.timestamp ? { timestamp: call.timestamp } : {}),
  }
}

export function extractCodexUpdatePlanSnapshotsFromLines(
  sessionLines: string[]
): CodexUpdatePlanSnapshot[] {
  const snapshots: CodexUpdatePlanSnapshot[] = []
  for (const line of sessionLines) {
    const snapshot = parseCodexPlanSnapshot(line)
    if (snapshot) snapshots.push(snapshot)
  }
  return snapshots
}

export function extractCodexUpdatePlanSnapshots(jsonlText: string): CodexUpdatePlanSnapshot[] {
  return extractCodexUpdatePlanSnapshotsFromLines(extractSessionLines(jsonlText))
}

function planTaskId(index: number): string {
  return `${CODEX_PLAN_TASK_ID_PREFIX}${index + 1}`
}

function buildPlanDescription(index: number): string {
  return `Imported from Codex update_plan item ${index + 1}.`
}

function applyStatusTiming(task: Task, oldStatus: TaskStatus | null, newStatus: TaskStatus): void {
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  if (oldStatus === newStatus && task.statusChangedAt) return

  if (oldStatus === "in_progress" && task.statusChangedAt) {
    const elapsed = nowMs - new Date(task.statusChangedAt).getTime()
    task.elapsedMs = (task.elapsedMs ?? 0) + Math.max(0, elapsed)
  }

  task.statusChangedAt = nowIso
  if (newStatus === "in_progress") task.startedAt = nowMs
  if (newStatus === "completed") {
    task.completedAt = nowMs
    if (!task.completionTimestamp) task.completionTimestamp = nowIso
  }
}

function buildPlanTask(
  existing: Task | undefined,
  id: string,
  item: CodexUpdatePlanTask,
  index: number
): Task {
  const task: Task = existing
    ? { ...existing }
    : {
        id,
        subject: item.step,
        description: buildPlanDescription(index),
        status: item.status,
        blocks: [],
        blockedBy: [],
        elapsedMs: 0,
        startedAt: null,
        completedAt: null,
      }

  const oldStatus = existing?.status ?? null
  task.subject = item.step
  task.description = buildPlanDescription(index)
  task.activeForm = item.status === "in_progress" ? item.step : undefined
  task.status = item.status
  task.subjectFingerprint = computeSubjectFingerprint(item.step)
  applyStatusTiming(task, oldStatus, item.status)
  return task
}

function hasTaskChanged(existing: Task | undefined, next: Task): boolean {
  if (!existing) return true
  return (
    existing.subject !== next.subject ||
    existing.description !== next.description ||
    existing.status !== next.status ||
    existing.activeForm !== next.activeForm
  )
}

async function writePlanTask(
  sessionId: string,
  task: Task,
  existing: Task | undefined,
  cwd: string,
  tasksDir: string
): Promise<"created" | "updated" | "unchanged"> {
  if (!hasTaskChanged(existing, task)) return "unchanged"

  await writeTask(sessionId, task, cwd, tasksDir)
  await writeAudit(
    sessionId,
    existing
      ? {
          timestamp: new Date().toISOString(),
          taskId: task.id,
          action: existing.status !== task.status ? "status_change" : "field_update",
          oldStatus: existing.status,
          newStatus: task.status,
          subject: task.subject,
        }
      : {
          timestamp: new Date().toISOString(),
          taskId: task.id,
          action: "create",
          newStatus: task.status,
          subject: task.subject,
        },
    tasksDir
  )
  return existing ? "updated" : "created"
}

function cancelMissingPlanTask(existing: Task): Task {
  const task = { ...existing }
  task.activeForm = undefined
  task.status = "cancelled"
  applyStatusTiming(task, existing.status, "cancelled")
  return task
}

interface PlanSyncContext {
  sessionId: string
  snapshot: CodexUpdatePlanSnapshot
  cwd: string
  tasksDir: string
  existingById: Map<string, Task>
  finalById: Map<string, Task>
  seenPlanIds: Set<string>
  result: CodexUpdatePlanSyncResult
}

async function syncVisiblePlanTasks(ctx: PlanSyncContext): Promise<void> {
  for (let index = 0; index < ctx.snapshot.plan.length; index++) {
    const item = ctx.snapshot.plan[index]
    if (!item) continue
    const id = planTaskId(index)
    ctx.seenPlanIds.add(id)
    const existing = ctx.existingById.get(id)
    const task = buildPlanTask(existing, id, item, index)
    const outcome = await writePlanTask(ctx.sessionId, task, existing, ctx.cwd, ctx.tasksDir)
    ctx.result[outcome]++
    ctx.finalById.set(id, task)
  }
}

async function cancelOmittedPlanTasks(ctx: PlanSyncContext, existingTasks: Task[]): Promise<void> {
  for (const existing of existingTasks) {
    if (!isCodexPlanTaskId(existing.id) || ctx.seenPlanIds.has(existing.id)) continue
    if (existing.status === "completed" || existing.status === "cancelled") {
      ctx.result.unchanged++
      continue
    }
    const cancelled = cancelMissingPlanTask(existing)
    await writePlanTask(ctx.sessionId, cancelled, existing, ctx.cwd, ctx.tasksDir)
    ctx.result.cancelled++
    ctx.finalById.set(existing.id, cancelled)
  }
}

function applyPlanSnapshotToEventState(sessionId: string, tasks: Task[]): void {
  applyTaskListEvent(
    sessionId,
    tasks.map((task) => ({ id: task.id, status: task.status, subject: task.subject }))
  )
  applyCacheTaskListSnapshot(sessionId, tasks)
}

export async function syncCodexUpdatePlanSnapshot(
  sessionId: string,
  snapshot: CodexUpdatePlanSnapshot,
  options: { cwd?: string; tasksDir?: string } = {}
): Promise<CodexUpdatePlanSyncResult> {
  const tasksDir = options.tasksDir ?? getProviderTaskRoots("codex")?.tasksDir
  if (!tasksDir) return { snapshots: 1, created: 0, updated: 0, cancelled: 0, unchanged: 0 }

  const cwd = options.cwd ?? process.cwd()
  await mkdir(join(tasksDir, sessionId), { recursive: true })
  const existingTasks = await readTasks(sessionId, tasksDir)
  const existingById = new Map(existingTasks.map((task) => [task.id, task]))
  const seenPlanIds = new Set<string>()
  const finalById = new Map(existingTasks.map((task) => [task.id, task]))
  const result: CodexUpdatePlanSyncResult = {
    snapshots: 1,
    created: 0,
    updated: 0,
    cancelled: 0,
    unchanged: 0,
  }
  const ctx: PlanSyncContext = {
    sessionId,
    snapshot,
    cwd,
    tasksDir,
    existingById,
    finalById,
    seenPlanIds,
    result,
  }

  await syncVisiblePlanTasks(ctx)
  await cancelOmittedPlanTasks(ctx, existingTasks)

  const finalTasks = [...finalById.values()].sort((left, right) => left.id.localeCompare(right.id))
  applyPlanSnapshotToEventState(sessionId, finalTasks)
  return result
}

export async function syncCodexUpdatePlanFromTranscriptSummary(
  payload: Record<string, unknown>,
  summary: TranscriptSummary | null
): Promise<CodexUpdatePlanSyncResult | null> {
  const agent = detectCurrentAgentFromHookPayload(payload)
  if (agent?.id !== "codex") return null

  const sessionId = typeof payload.session_id === "string" ? payload.session_id : ""
  if (!sessionId) return null

  const snapshots = summary
    ? extractCodexUpdatePlanSnapshotsFromLines(summary.sessionLines)
    : await readSnapshotsFromTranscriptPath(payload)
  const latest = snapshots.at(-1)
  if (!latest) return { snapshots: 0, created: 0, updated: 0, cancelled: 0, unchanged: 0 }

  const result = await syncCodexUpdatePlanSnapshot(sessionId, latest, {
    cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
  })
  return { ...result, snapshots: snapshots.length }
}

async function readSnapshotsFromTranscriptPath(
  payload: Record<string, unknown>
): Promise<CodexUpdatePlanSnapshot[]> {
  const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : ""
  if (!transcriptPath) return []
  try {
    const text = await Bun.file(transcriptPath).text()
    return extractCodexUpdatePlanSnapshotsFromLines(extractSessionLines(text))
  } catch {
    return []
  }
}

export function extractCodexUpdatePlanSnapshotsFromRawJsonl(
  jsonlText: string
): CodexUpdatePlanSnapshot[] {
  return extractCodexUpdatePlanSnapshotsFromLines(splitJsonlLines(jsonlText))
}
