/**
 * Weighted divergence signal — issue #844, phase 1 (telemetry only).
 *
 * `divergence = Σ weight(call)` over governed tool calls since the last
 * task-movement event. The queue-depth proxy this replaces had inverted
 * incidence: an agent honestly draining its queue tripped low-depth
 * advisories, while an agent that stopped planning but kept calling tools
 * never tripped anything. This counter grows only while work happens
 * without task movement and resets to zero on real movement.
 *
 * Weight table (issue #844):
 *   0 — sampling and read-only work: task tools, file reads and searches,
 *       and every shell command the require-tasks gate exempts. Single
 *       source of truth: `isTaskTrackingExemptShellCommand` plus the
 *       shared tool-matcher sets, so this signal and the gate cannot
 *       drift apart.
 *   1 — local mutation: Edit/Write/NotebookEdit and non-exempt shell.
 *   2 — outward/irreversible: `git commit`/`git push`, `gh` mutations,
 *       and `swiz issue` writes. Outwardness is checked BEFORE the exempt
 *       set: the gate exempts `git push` and all of `gh` for task-tracking
 *       purposes, but shipping while off-plan is the strongest drift
 *       evidence there is.
 *
 * Movement (resets the sum): TaskCreate, or a TaskUpdate that would
 * actually change its task — a valid status transition, a different
 * subject or description, or a blocks/blockedBy edit with real effect.
 * Bare TaskList/TaskGet and no-op TaskUpdates are sampling, not movement,
 * and never reset. Where prior task state is unavailable, a
 * field-carrying TaskUpdate counts as movement — optimism in the honest
 * direction: a missed reset fires a false advisory later, while a
 * fabricated reset would hide real drift. A TaskUpdate carrying no
 * mutating fields is a no-op regardless of prior state and never counts.
 *
 * State is in-memory per session. lefthook restarts the daemon on every
 * commit, so consumers rebuild lazily from the captured tool-call JSONL
 * via `recoverSessionDivergence` — best-effort: shell details are
 * truncated to 80 characters at capture time and prior task state is
 * gone, so recovered movement uses the field-carrying rule only.
 *
 * Phase 1 exposes the counter and provisional thresholds for observation
 * only; no hook consumes them yet (rollout step 2 in #844 swaps the
 * queue-depth advisory separately, gated on observed distributions).
 */

import { debugLog } from "../../debug.ts"
import { isValidTransition } from "../../tasks/task-transitions.ts"
import {
  isAnyProviderTaskCreateTool,
  isAnyProviderTaskUpdateTool,
  isCodeChangeTool,
  isShellTool,
  isTaskTool,
  READ_TOOLS,
  SEARCH_TOOLS,
  stripMcpToolNamespace,
} from "../../tool-matchers.ts"
import {
  GIT_COMMIT_RE,
  GIT_PUSH_RE,
  isTaskTrackingExemptShellCommand,
} from "../../utils/git-utils.ts"
import type { CapturedToolCall } from "./utils.ts"

// ─── Types ──────────────────────────────────────────────────────────────────

export type DivergenceWeight = 0 | 1 | 2

export type DivergenceMovementKind = "task-create" | "task-update"

/** One completed divergence run: the counter's value when movement ended it. */
export interface DivergencePeak {
  endedAt: string
  peak: number
  calls: number
  movementKind: DivergenceMovementKind
}

export interface SessionDivergenceState {
  weightedSum: number
  callsSinceMovement: number
  lastMovementAt: string | null
  lastMovementKind: DivergenceMovementKind | null
  peaks: DivergencePeak[]
  updatedAt: number
}

/** Read-only view served to snapshot consumers (status line, dashboard). */
export interface DivergenceSnapshot {
  weightedSum: number
  callsSinceMovement: number
  lastMovementAt: string | null
  lastMovementKind: DivergenceMovementKind | null
  advisoryThreshold: number
  steerThreshold: number
  recentPeaks: DivergencePeak[]
}

/**
 * Prior task state for no-op detection. `undefined` fields mean "unknown to
 * the source" (e.g. event-state carries only id/status/subject) and compare
 * optimistically; `null` description means "known to be absent".
 */
export interface PriorTaskState {
  id: string
  status: string
  subject?: string
  description?: string | null
  blockedBy?: readonly string[]
  blocks?: readonly string[]
}

// ─── Bounds and thresholds ──────────────────────────────────────────────────

export const MAX_DIVERGENCE_PEAKS = 50
export const MAX_DIVERGENCE_SESSIONS = 200
const SNAPSHOT_RECENT_PEAKS = 10

export const DEFAULT_DIVERGENCE_ADVISORY_THRESHOLD = 15
export const DEFAULT_DIVERGENCE_STEER_THRESHOLD = 30

/**
 * Threshold resolution seam. Phase 1 observes only, so this returns the
 * provisional defaults; phase 2 wires project > global > default resolution
 * through the settings registry (a surface this change deliberately does not
 * touch) the way the memory-size hooks resolve theirs.
 */
export function divergenceThresholds(): { advisoryThreshold: number; steerThreshold: number } {
  return {
    advisoryThreshold: DEFAULT_DIVERGENCE_ADVISORY_THRESHOLD,
    steerThreshold: DEFAULT_DIVERGENCE_STEER_THRESHOLD,
  }
}

// ─── Weight classification ──────────────────────────────────────────────────

/** `gh <area> <mutating-verb>` — the CLI forms that write to GitHub. */
const GH_SUBCOMMAND_MUTATION_RE =
  /\bgh\s+(?:issue|pr|release|repo|label|gist|workflow|run|api)\s+(?:create|edit|close|comment|merge|review|delete|reopen|lock|unlock|cancel|rerun|dispatch)\b/

/** `gh api` with a non-GET method or body fields (fields imply POST). */
const GH_API_MUTATION_RE =
  /\bgh\s+api\b(?=[\s\S]*?(?:\s-X\s*(?:POST|PATCH|PUT|DELETE)\b|\s--method(?:=|\s+)(?:POST|PATCH|PUT|DELETE)\b|\s-[fF]\s|\s--(?:field|raw-field)(?:=|\s)))/

/** `swiz issue` writes (close/comment plus the resolve composite). */
const OUTWARD_SWIZ_ISSUE_RE = /\bswiz\s+issue\s+(?:close|comment|resolve)\b/

export function isOutwardShellCommand(command: string): boolean {
  return (
    GIT_COMMIT_RE.test(command) ||
    GIT_PUSH_RE.test(command) ||
    GH_SUBCOMMAND_MUTATION_RE.test(command) ||
    GH_API_MUTATION_RE.test(command) ||
    OUTWARD_SWIZ_ISSUE_RE.test(command)
  )
}

export function classifyShellCommandWeight(command: string): DivergenceWeight {
  if (!command) return 1
  if (isOutwardShellCommand(command)) return 2
  if (isTaskTrackingExemptShellCommand(command)) return 0
  return 1
}

function shellCommandFromInput(toolInput: Record<string, any> | undefined): string {
  const command = toolInput?.command ?? toolInput?.cmd
  return typeof command === "string" ? command : ""
}

export function classifyDivergenceWeight(
  toolName: string,
  toolInput: Record<string, any> | undefined
): DivergenceWeight {
  const canonical = stripMcpToolNamespace(toolName)
  if (isTaskTool(canonical)) return 0
  if (READ_TOOLS.has(canonical) || SEARCH_TOOLS.has(canonical)) return 0
  if (isShellTool(canonical)) return classifyShellCommandWeight(shellCommandFromInput(toolInput))
  if (isCodeChangeTool(canonical)) return 1
  return 0
}

// ─── Movement resolution ────────────────────────────────────────────────────

function normalizeTaskId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const id = value.trim().replace(/^#/, "")
  return id || null
}

function normalizeIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  for (const entry of value) {
    const id = normalizeTaskId(entry)
    if (id) ids.push(id)
  }
  return ids
}

/**
 * True when the update carries any field that could change the task. An
 * update without one (a bare `{taskId}`) is a no-op by construction, so it
 * never counts as movement even when prior state is unavailable.
 */
export function hasMutatingUpdateFields(toolInput: Record<string, any> | undefined): boolean {
  if (!toolInput) return false
  return (
    typeof toolInput.status === "string" ||
    typeof toolInput.subject === "string" ||
    typeof toolInput.description === "string" ||
    normalizeIdArray(toolInput.addBlockedBy).length > 0 ||
    normalizeIdArray(toolInput.addBlocks).length > 0 ||
    normalizeIdArray(toolInput.removeBlockedBy).length > 0 ||
    normalizeIdArray(toolInput.removeBlocks).length > 0
  )
}

function statusChanges(requested: unknown, prior: PriorTaskState): boolean {
  if (typeof requested !== "string" || requested === prior.status) return false
  return isValidTransition(prior.status, requested)
}

function textFieldChanges(requested: unknown, prior: string | null | undefined): boolean {
  if (typeof requested !== "string") return false
  if (prior === undefined) return true
  return requested !== (prior ?? "")
}

function normalizedIdSet(prior: readonly string[]): Set<string> {
  const set = new Set<string>()
  for (const entry of prior) {
    const id = normalizeTaskId(entry)
    if (id) set.add(id)
  }
  return set
}

function edgeAdditionsChange(requested: unknown, prior: readonly string[] | undefined): boolean {
  const ids = normalizeIdArray(requested)
  if (ids.length === 0) return false
  if (prior === undefined) return true
  const held = normalizedIdSet(prior)
  return ids.some((id) => !held.has(id))
}

function edgeRemovalsChange(requested: unknown, prior: readonly string[] | undefined): boolean {
  const ids = normalizeIdArray(requested)
  if (ids.length === 0) return false
  if (prior === undefined) return true
  const held = normalizedIdSet(prior)
  return ids.some((id) => held.has(id))
}

function taskUpdateChangesPrior(toolInput: Record<string, any>, prior: PriorTaskState): boolean {
  return (
    statusChanges(toolInput.status, prior) ||
    textFieldChanges(toolInput.subject, prior.subject) ||
    textFieldChanges(toolInput.description, prior.description) ||
    edgeAdditionsChange(toolInput.addBlockedBy, prior.blockedBy) ||
    edgeAdditionsChange(toolInput.addBlocks, prior.blocks) ||
    edgeRemovalsChange(toolInput.removeBlockedBy, prior.blockedBy) ||
    edgeRemovalsChange(toolInput.removeBlocks, prior.blocks)
  )
}

/**
 * Decide whether a task tool call is a movement event.
 *
 * `priorTasks: null` means no prior state was obtainable — a field-carrying
 * update counts as movement (documented optimism). A provided-but-missing
 * task is NOT movement: the store will reject the update, and treating it
 * as movement would let updates against invented ids reset the counter.
 */
export function resolveTaskMovement(
  toolName: string,
  toolInput: Record<string, any> | undefined,
  priorTasks: readonly PriorTaskState[] | null
): DivergenceMovementKind | null {
  if (isAnyProviderTaskCreateTool(toolName)) return "task-create"
  if (!isAnyProviderTaskUpdateTool(toolName)) return null
  if (!hasMutatingUpdateFields(toolInput)) return null
  const input = toolInput ?? {}
  if (priorTasks === null) return "task-update"
  const taskId = normalizeTaskId(input.taskId ?? input.id)
  const prior = taskId ? priorTasks.find((task) => normalizeTaskId(task.id) === taskId) : undefined
  if (!prior) return null
  return taskUpdateChangesPrior(input, prior) ? "task-update" : null
}

// ─── State accumulation ─────────────────────────────────────────────────────

function freshDivergenceState(nowMs: number): SessionDivergenceState {
  return {
    weightedSum: 0,
    callsSinceMovement: 0,
    lastMovementAt: null,
    lastMovementKind: null,
    peaks: [],
    updatedAt: nowMs,
  }
}

function applyMovement(
  state: SessionDivergenceState,
  kind: DivergenceMovementKind,
  nowMs: number,
  sessionId: string
): void {
  const endedAt = new Date(nowMs).toISOString()
  if (state.weightedSum > 0 || state.callsSinceMovement > 0) {
    state.peaks.push({
      endedAt,
      peak: state.weightedSum,
      calls: state.callsSinceMovement,
      movementKind: kind,
    })
    if (state.peaks.length > MAX_DIVERGENCE_PEAKS) {
      state.peaks.splice(0, state.peaks.length - MAX_DIVERGENCE_PEAKS)
    }
    debugLog(
      `[divergence] session=${sessionId.slice(0, 8)} run ended: peak=${state.weightedSum} ` +
        `calls=${state.callsSinceMovement} movement=${kind}`
    )
  }
  state.weightedSum = 0
  state.callsSinceMovement = 0
  state.lastMovementAt = endedAt
  state.lastMovementKind = kind
}

function evictStaleDivergenceSessions(
  sessionDivergence: Map<string, SessionDivergenceState>
): void {
  while (sessionDivergence.size > MAX_DIVERGENCE_SESSIONS) {
    let oldestId: string | null = null
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [sessionId, state] of sessionDivergence) {
      if (state.updatedAt < oldestAt) {
        oldestAt = state.updatedAt
        oldestId = sessionId
      }
    }
    if (oldestId === null) return
    sessionDivergence.delete(oldestId)
  }
}

/**
 * One governed tool call to record. `movement` is precomputed by the caller —
 * prior-state lookup is async and source-dependent, while recording stays sync.
 */
export interface DivergenceCallRecord {
  sessionId: string
  toolName: string
  toolInput?: Record<string, any>
  nowMs: number
  movement: DivergenceMovementKind | null
}

export function recordDivergenceToolCall(
  sessionDivergence: Map<string, SessionDivergenceState>,
  call: DivergenceCallRecord
): SessionDivergenceState {
  const { sessionId, toolName, toolInput, nowMs, movement } = call
  const state = sessionDivergence.get(sessionId) ?? freshDivergenceState(nowMs)
  if (movement) {
    applyMovement(state, movement, nowMs, sessionId)
  } else {
    state.weightedSum += classifyDivergenceWeight(toolName, toolInput)
    state.callsSinceMovement += 1
  }
  state.updatedAt = nowMs
  sessionDivergence.set(sessionId, state)
  evictStaleDivergenceSessions(sessionDivergence)
  return state
}

export function snapshotSessionDivergence(
  sessionDivergence: Map<string, SessionDivergenceState>,
  sessionId: string
): DivergenceSnapshot | null {
  const state = sessionDivergence.get(sessionId)
  if (!state) return null
  return {
    weightedSum: state.weightedSum,
    callsSinceMovement: state.callsSinceMovement,
    lastMovementAt: state.lastMovementAt,
    lastMovementKind: state.lastMovementKind,
    ...divergenceThresholds(),
    recentPeaks: state.peaks.slice(-SNAPSHOT_RECENT_PEAKS),
  }
}

// ─── Recovery from the captured tool-call ledger ────────────────────────────

function capturedInputFromDetail(call: CapturedToolCall): Record<string, any> | undefined {
  const canonical = stripMcpToolNamespace(call.name)
  if (isTaskTool(canonical)) {
    try {
      const parsed: unknown = JSON.parse(call.detail)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, any>
      }
    } catch {
      return undefined
    }
    return undefined
  }
  // Shell details are the command truncated to 80 chars by the capture
  // layer; prefix-anchored classifiers still work for typical commands.
  if (isShellTool(canonical)) return { command: call.detail }
  return undefined
}

/**
 * Rebuild a session's divergence state from its persisted captured calls
 * after a daemon restart. Prior task state is unavailable here, so
 * movement uses the field-carrying rule (`priorTasks: null`).
 */
export function recoverSessionDivergence(
  calls: readonly CapturedToolCall[],
  nowMs: number
): SessionDivergenceState {
  const state = freshDivergenceState(nowMs)
  for (const call of calls) {
    const toolInput = capturedInputFromDetail(call)
    const movement = resolveTaskMovement(call.name, toolInput, null)
    const atMs = Date.parse(call.timestamp)
    const callMs = Number.isFinite(atMs) ? atMs : nowMs
    if (movement) {
      applyMovement(state, movement, callMs, "recovered")
    } else {
      state.weightedSum += classifyDivergenceWeight(call.name, toolInput)
      state.callsSinceMovement += 1
    }
    state.updatedAt = callMs
  }
  state.updatedAt = nowMs
  return state
}
