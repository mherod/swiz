import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { detectCurrentAgentFromHookPayload } from "../agent-paths.ts"
import { getProviderTaskRoots } from "../provider-adapters.ts"
import { computeSubjectFingerprint } from "../subject-fingerprint.ts"
import { extractSessionLines, type TranscriptSummary } from "../transcript-summary.ts"
import { CappedMap } from "../utils/capped-map.ts"
import { readJsonlTailTextFromFile, splitJsonlLines, tryParseJsonLine } from "../utils/jsonl.ts"
import { applyTaskListEvent } from "./task-event-state.ts"
import { applyCacheTaskListSnapshot } from "./task-recovery.ts"
import {
  atomicWriteJson,
  readTasks,
  sessionDirPath,
  type Task,
  type TaskBatchWrite,
  type TaskStatus,
  writeTaskBatch,
} from "./task-repository.ts"
import { writeCanonicalTaskListSyncSentinel } from "./task-state-cache.ts"

export const CODEX_UPDATE_PLAN_TOOL_NAMES = new Set(["update_plan", "functions.update_plan"])
const CODEX_PLAN_TASK_ID_PREFIX = "codex-"
const CODEX_PLAN_SYNC_MARKER_FILE = ".codex-plan-sync.json"
const CODEX_PLAN_SYNC_MARKER_VERSION = 1
const CODEX_PLAN_SYNC_MARKER_CACHE_SIZE = 200
const SHA256_HEX_RE = /^[a-f0-9]{64}$/

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

interface CodexUpdatePlanTask {
  step: string
  status: TaskStatus
}

export interface CodexUpdatePlanSnapshot {
  explanation?: string
  plan: CodexUpdatePlanTask[]
  callId?: string
  timestamp?: string
  sourceOrdinal?: number
}

export interface CodexUpdatePlanSyncResult {
  snapshots: number
  created: number
  updated: number
  cancelled: number
  unchanged: number
  skipped: number
  samePlan: number
}

export interface CodexPlanSyncMarker {
  version: typeof CODEX_PLAN_SYNC_MARKER_VERSION
  snapshotIdentity: string
  planFingerprint: string
  appliedAt: string
}

export interface CodexPlanSyncMetrics {
  exactSnapshotSkips: number
  samePlanSkips: number
  applied: number
  failed: number
  totalDurationMs: number
  maxDurationMs: number
}

export interface CodexPlanSyncOptions {
  cwd?: string
  tasksDir?: string
  writeMarker?: (markerPath: string, marker: CodexPlanSyncMarker) => Promise<void>
  writeSentinel?: (sessionId: string) => Promise<void>
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

const codexPlanSyncMarkerSchema = z
  .object({
    version: z.literal(CODEX_PLAN_SYNC_MARKER_VERSION),
    snapshotIdentity: z.string().regex(SHA256_HEX_RE),
    planFingerprint: z.string().regex(SHA256_HEX_RE),
    appliedAt: z.string().datetime(),
  })
  .strict()

const appliedPlanMarkers = new CappedMap<string, CodexPlanSyncMarker>(
  CODEX_PLAN_SYNC_MARKER_CACHE_SIZE
)
const snapshotIdentityArguments = new WeakMap<CodexUpdatePlanSnapshot, string>()
const codexPlanSyncMetrics: CodexPlanSyncMetrics = {
  exactSnapshotSkips: 0,
  samePlanSkips: 0,
  applied: 0,
  failed: 0,
  totalDurationMs: 0,
  maxDurationMs: 0,
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : JSON.stringify(String(value))
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(String(value))
}

function sha256(material: string): string {
  return createHash("sha256").update(material).digest("hex")
}

function getSnapshotIdentity(snapshot: CodexUpdatePlanSnapshot): string {
  if (snapshot.callId) return sha256(`codex-plan-call-id-v1:${snapshot.callId}`)
  return sha256(
    `codex-plan-fallback-v1:${canonicalJson({
      timestamp: snapshot.timestamp ?? "",
      sourceOrdinal: snapshot.sourceOrdinal ?? -1,
      arguments:
        snapshotIdentityArguments.get(snapshot) ??
        canonicalJson({ explanation: snapshot.explanation ?? "", plan: snapshot.plan }),
    })}`
  )
}

function getPlanFingerprint(snapshot: CodexUpdatePlanSnapshot): string {
  return sha256(
    `codex-plan-content-v1:${canonicalJson(
      snapshot.plan.map((item) => ({ step: item.step, status: item.status }))
    )}`
  )
}

function planMarkerCacheKey(sessionId: string, tasksDir: string): string {
  return `${tasksDir}\0${sessionId}`
}

/**
 * Marker path for a session, refusing an id that escapes the task store.
 *
 * Throwing suits both callers: the writer must not create a marker outside the store, and the
 * reader already treats any failure as "no marker" inside its own try/catch.
 */
export function codexPlanSyncMarkerPath(sessionId: string, tasksDir: string): string {
  return join(sessionDirPath(sessionId, tasksDir), CODEX_PLAN_SYNC_MARKER_FILE)
}

async function readAppliedPlanMarker(
  sessionId: string,
  tasksDir: string
): Promise<CodexPlanSyncMarker | null> {
  const cacheKey = planMarkerCacheKey(sessionId, tasksDir)
  const cached = appliedPlanMarkers.get(cacheKey)
  if (cached) return cached

  try {
    const text = await Bun.file(codexPlanSyncMarkerPath(sessionId, tasksDir)).text()
    const parsed = codexPlanSyncMarkerSchema.safeParse(JSON.parse(text))
    if (!parsed.success) return null
    appliedPlanMarkers.set(cacheKey, parsed.data)
    return parsed.data
  } catch {
    return null
  }
}

async function writeAppliedPlanMarker(
  sessionId: string,
  tasksDir: string,
  snapshotIdentity: string,
  planFingerprint: string,
  writeMarker?: CodexPlanSyncOptions["writeMarker"]
): Promise<void> {
  const marker: CodexPlanSyncMarker = {
    version: CODEX_PLAN_SYNC_MARKER_VERSION,
    snapshotIdentity,
    planFingerprint,
    appliedAt: new Date().toISOString(),
  }
  const markerPath = codexPlanSyncMarkerPath(sessionId, tasksDir)
  await mkdir(sessionDirPath(sessionId, tasksDir), { recursive: true })
  if (writeMarker) await writeMarker(markerPath, marker)
  else await atomicWriteJson(markerPath, marker)
  appliedPlanMarkers.set(planMarkerCacheKey(sessionId, tasksDir), marker)
}

function recordCodexPlanSync(result: CodexUpdatePlanSyncResult, durationMs: number): void {
  if (result.skipped > 0) codexPlanSyncMetrics.exactSnapshotSkips++
  else if (result.samePlan > 0) codexPlanSyncMetrics.samePlanSkips++
  else if (result.snapshots > 0) codexPlanSyncMetrics.applied++
  codexPlanSyncMetrics.totalDurationMs += durationMs
  codexPlanSyncMetrics.maxDurationMs = Math.max(codexPlanSyncMetrics.maxDurationMs, durationMs)
}

function recordCodexPlanSyncFailure(durationMs: number): void {
  codexPlanSyncMetrics.failed++
  codexPlanSyncMetrics.totalDurationMs += durationMs
  codexPlanSyncMetrics.maxDurationMs = Math.max(codexPlanSyncMetrics.maxDurationMs, durationMs)
}

export function getCodexPlanSyncMetrics(): CodexPlanSyncMetrics {
  return { ...codexPlanSyncMetrics }
}

export function resetCodexPlanSyncStateForTests(): void {
  appliedPlanMarkers.clear()
  codexPlanSyncMetrics.exactSnapshotSkips = 0
  codexPlanSyncMetrics.samePlanSkips = 0
  codexPlanSyncMetrics.applied = 0
  codexPlanSyncMetrics.failed = 0
  codexPlanSyncMetrics.totalDurationMs = 0
  codexPlanSyncMetrics.maxDurationMs = 0
}

export function isCodexPlanTaskId(taskId: string): boolean {
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

function parseCodexPlanSnapshot(
  line: string,
  sourceOrdinal?: number
): CodexUpdatePlanSnapshot | null {
  const call = parseCodexFunctionCallLine(line)
  if (!call || !isCodexUpdatePlanPayload(call.payload)) return null

  const tasks = parseCodexPlanArguments(call.payload.arguments)
  if (!tasks) return null

  const explanation = parseCodexPlanExplanation(call.payload.arguments)
  const identityArguments = canonicalJson(
    parsePlanArgumentsObject(call.payload.arguments) ?? call.payload.arguments
  )

  const snapshot: CodexUpdatePlanSnapshot = {
    ...(explanation ? { explanation } : {}),
    plan: tasks,
    ...(call.payload.call_id ? { callId: call.payload.call_id } : {}),
    ...(call.timestamp ? { timestamp: call.timestamp } : {}),
    ...(sourceOrdinal !== undefined ? { sourceOrdinal } : {}),
  }
  snapshotIdentityArguments.set(snapshot, identityArguments)
  return snapshot
}

function extractCodexUpdatePlanSnapshotsFromLines(
  sessionLines: string[]
): CodexUpdatePlanSnapshot[] {
  const snapshots: CodexUpdatePlanSnapshot[] = []
  for (let index = 0; index < sessionLines.length; index++) {
    const line = sessionLines[index]
    if (!line) continue
    const snapshot = parseCodexPlanSnapshot(line, index)
    if (snapshot) snapshots.push(snapshot)
  }
  return snapshots
}

function findLatestCodexUpdatePlanSnapshot(sessionLines: string[]): CodexUpdatePlanSnapshot | null {
  for (let index = sessionLines.length - 1; index >= 0; index--) {
    const line = sessionLines[index]
    if (!line) continue
    const snapshot = parseCodexPlanSnapshot(line, index)
    if (snapshot) return snapshot
  }
  return null
}

export function extractCodexUpdatePlanSnapshots(jsonlText: string): CodexUpdatePlanSnapshot[] {
  return extractCodexUpdatePlanSnapshotsFromLines(extractSessionLines(jsonlText))
}

export function codexPlanTaskId(index: number): string {
  return `${CODEX_PLAN_TASK_ID_PREFIX}${index + 1}`
}

function buildPlanDescription(index: number): string {
  return `Imported from Codex update_plan item ${index + 1}.`
}

function applyStatusTiming(task: Task, oldStatus: TaskStatus | null, newStatus: TaskStatus): void {
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  if (newStatus !== "completed") {
    task.completedAt = null
    task.completionTimestamp = undefined
    task.completionEvidence = undefined
  }
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
    existing.activeForm !== next.activeForm ||
    existing.completedAt !== next.completedAt ||
    existing.completionTimestamp !== next.completionTimestamp ||
    existing.completionEvidence !== next.completionEvidence
  )
}

function stagePlanTask(
  task: Task,
  existing: Task | undefined,
  writes: TaskBatchWrite[],
  snapshotIdentity: string
): "created" | "updated" | "unchanged" {
  if (!hasTaskChanged(existing, task)) return "unchanged"

  writes.push({
    task,
    audit: existing
      ? {
          timestamp: new Date().toISOString(),
          taskId: task.id,
          action: existing.status !== task.status ? "status_change" : "field_update",
          oldStatus: existing.status,
          newStatus: task.status,
          subject: task.subject,
          operationId: sha256(`codex-plan-audit-v1:${snapshotIdentity}:${task.id}`),
        }
      : {
          timestamp: new Date().toISOString(),
          taskId: task.id,
          action: "create",
          newStatus: task.status,
          subject: task.subject,
          operationId: sha256(`codex-plan-audit-v1:${snapshotIdentity}:${task.id}`),
        },
  })
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
  snapshot: CodexUpdatePlanSnapshot
  snapshotIdentity: string
  existingById: Map<string, Task>
  finalById: Map<string, Task>
  seenPlanIds: Set<string>
  writes: TaskBatchWrite[]
  result: CodexUpdatePlanSyncResult
}

function syncVisiblePlanTasks(ctx: PlanSyncContext): void {
  for (let index = 0; index < ctx.snapshot.plan.length; index++) {
    const item = ctx.snapshot.plan[index]
    if (!item) continue
    const id = codexPlanTaskId(index)
    ctx.seenPlanIds.add(id)
    const existing = ctx.existingById.get(id)
    const task = buildPlanTask(existing, id, item, index)
    const outcome = stagePlanTask(task, existing, ctx.writes, ctx.snapshotIdentity)
    ctx.result[outcome]++
    ctx.finalById.set(id, task)
  }
}

function cancelOmittedPlanTasks(ctx: PlanSyncContext, existingTasks: Task[]): void {
  for (const existing of existingTasks) {
    if (!isCodexPlanTaskId(existing.id) || ctx.seenPlanIds.has(existing.id)) continue
    if (existing.status === "completed" || existing.status === "cancelled") {
      ctx.result.unchanged++
      continue
    }
    const cancelled = cancelMissingPlanTask(existing)
    stagePlanTask(cancelled, existing, ctx.writes, ctx.snapshotIdentity)
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

function createSyncResult(snapshots: number): CodexUpdatePlanSyncResult {
  return {
    snapshots,
    created: 0,
    updated: 0,
    cancelled: 0,
    unchanged: 0,
    skipped: 0,
    samePlan: 0,
  }
}

function finishCodexPlanSync(
  result: CodexUpdatePlanSyncResult,
  startedAt: number
): CodexUpdatePlanSyncResult {
  recordCodexPlanSync(result, Math.max(0, performance.now() - startedAt))
  return result
}

async function writePlanSyncSentinel(
  sessionId: string,
  writeSentinel?: CodexPlanSyncOptions["writeSentinel"]
): Promise<void> {
  if (writeSentinel) {
    await writeSentinel(sessionId)
    return
  }
  await writeCanonicalTaskListSyncSentinel(sessionId, Date.now(), { throwOnError: true })
}

async function syncAppliedPlanMarker(
  sessionId: string,
  tasksDir: string,
  snapshotIdentity: string,
  planFingerprint: string,
  options: Pick<CodexPlanSyncOptions, "writeMarker" | "writeSentinel">
): Promise<CodexUpdatePlanSyncResult | null> {
  const appliedMarker = await readAppliedPlanMarker(sessionId, tasksDir)
  if (appliedMarker?.snapshotIdentity === snapshotIdentity) {
    const result = createSyncResult(1)
    result.skipped = 1
    return result
  }

  if (appliedMarker?.planFingerprint !== planFingerprint) return null

  await writePlanSyncSentinel(sessionId, options.writeSentinel)
  await writeAppliedPlanMarker(
    sessionId,
    tasksDir,
    snapshotIdentity,
    planFingerprint,
    options.writeMarker
  )
  const result = createSyncResult(1)
  result.samePlan = 1
  return result
}

export async function syncCodexUpdatePlanSnapshot(
  sessionId: string,
  snapshot: CodexUpdatePlanSnapshot,
  options: CodexPlanSyncOptions = {}
): Promise<CodexUpdatePlanSyncResult> {
  const startedAt = performance.now()
  const tasksDir = options.tasksDir ?? getProviderTaskRoots("codex")?.tasksDir
  if (!tasksDir) return finishCodexPlanSync(createSyncResult(1), startedAt)

  try {
    const snapshotIdentity = getSnapshotIdentity(snapshot)
    const planFingerprint = getPlanFingerprint(snapshot)
    const markerResult = await syncAppliedPlanMarker(
      sessionId,
      tasksDir,
      snapshotIdentity,
      planFingerprint,
      options
    )
    if (markerResult) return finishCodexPlanSync(markerResult, startedAt)

    const cwd = options.cwd ?? process.cwd()
    const existingTasks = await readTasks(sessionId, tasksDir)
    const existingById = new Map(existingTasks.map((task) => [task.id, task]))
    const seenPlanIds = new Set<string>()
    const finalById = new Map(existingTasks.map((task) => [task.id, task]))
    const result = createSyncResult(1)
    const writes: TaskBatchWrite[] = []
    const ctx: PlanSyncContext = {
      snapshot,
      snapshotIdentity,
      existingById,
      finalById,
      seenPlanIds,
      writes,
      result,
    }

    syncVisiblePlanTasks(ctx)
    cancelOmittedPlanTasks(ctx, existingTasks)

    const finalTasks = [...finalById.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    )
    await writeTaskBatch(sessionId, writes, finalTasks, cwd, tasksDir)
    applyPlanSnapshotToEventState(sessionId, finalTasks)
    await writePlanSyncSentinel(sessionId, options.writeSentinel)
    await writeAppliedPlanMarker(
      sessionId,
      tasksDir,
      snapshotIdentity,
      planFingerprint,
      options.writeMarker
    )
    return finishCodexPlanSync(result, startedAt)
  } catch (error) {
    recordCodexPlanSyncFailure(Math.max(0, performance.now() - startedAt))
    throw error
  }
}

export async function syncCodexUpdatePlanFromTranscriptSummary(
  payload: Record<string, unknown>,
  summary: TranscriptSummary | null
): Promise<CodexUpdatePlanSyncResult | null> {
  const agent = detectCurrentAgentFromHookPayload(payload)
  if (agent?.id !== "codex") return null

  const sessionId = typeof payload.session_id === "string" ? payload.session_id : ""
  if (!sessionId) return null

  const latest = summary
    ? findLatestCodexUpdatePlanSnapshot(summary.sessionLines)
    : await readLatestCodexUpdatePlanSnapshotFromTranscriptPath(payload)
  if (!latest) return createSyncResult(0)

  const result = await syncCodexUpdatePlanSnapshot(sessionId, latest, {
    cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
  })
  return result
}

async function readLatestCodexUpdatePlanSnapshotFromTranscriptPath(
  payload: Record<string, unknown>
): Promise<CodexUpdatePlanSnapshot | null> {
  const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : ""
  if (!transcriptPath) return null
  try {
    const transcript = Bun.file(transcriptPath)
    const metadata = await transcript.stat()
    const tail = await readJsonlTailTextFromFile(transcript, metadata.size, {
      isEnough: (text) => findLatestCodexUpdatePlanSnapshot(extractSessionLines(text)) !== null,
    })
    return findLatestCodexUpdatePlanSnapshot(extractSessionLines(tail.text))
  } catch {
    return null
  }
}

export function extractCodexUpdatePlanSnapshotsFromRawJsonl(
  jsonlText: string
): CodexUpdatePlanSnapshot[] {
  return extractCodexUpdatePlanSnapshotsFromLines(splitJsonlLines(jsonlText))
}
