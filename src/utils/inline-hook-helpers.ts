/**
 * Safe helper functions for inline SwizHook implementations.
 *
 * This module must NOT import from hook-utils.ts, skill-utils.ts, agents.ts,
 * or any module that creates a circular dependency through manifest.ts.
 *
 * Safe to import from manifest.ts via inline hooks.
 *
 * NOTE: formatActionPlan here omits translateToolNames support (requires agents.ts).
 * Hooks that need tool-name translation must remain file-based.
 */

import { LRUCache } from "lru-cache"
import type { PostToolHookInput, ToolHookInput } from "../schemas.ts"
import { JsonlAppendCursor, type JsonlAppendMetadata } from "./jsonl.ts"
import { shellTokenCommandRe } from "./shell-patterns.ts"

// ─── Issue guidance ──────────────────────────────────────────────────────────

export function buildIssueGuidance(
  repo: string | null,
  options?: { crossRepo?: boolean; hostname?: string }
): string {
  const isCrossRepo = options?.crossRepo ?? false
  const hostname = options?.hostname ?? "github.com"
  const hostnameFlag = hostname !== "github.com" ? ` --hostname ${hostname}` : ""
  const repoSlug = repo ?? "<owner>/<repo>"

  const prefix = isCrossRepo
    ? "If this change is needed, consider filing an issue there so the repo can triage it:"
    : "If you need to edit a file outside the project, file an issue on the target repo instead:"

  return `${prefix}\n  gh issue create --repo ${repoSlug}${hostnameFlag} --title "..." --body "..."`
}

// ─── Settings command detection ───────────────────────────────────────────────

export function isSettingDisableCommand(command: string, aliases: string[]): boolean {
  for (const alias of aliases) {
    if (new RegExp(`swiz\\s+settings\\s+disable\\s+${alias}(?:\\s|$)`).test(command)) return true
    if (new RegExp(`swiz\\s+settings\\s+set\\s+${alias}\\s+false(?:\\s|$)`).test(command))
      return true
  }
  return false
}

// ─── Swiz command detection ──────────────────────────────────────────────────

export const SWIZ_CMD_RE = shellTokenCommandRe("swiz(?:\\s|$)")

/**
 * Returns true if the Bash command is a `swiz` CLI invocation.
 * Swiz commands are globally exempt from PreToolUse blocking because the CLI
 * performs its own validation — blocking the project's own entry point creates
 * unrecoverable deadlocks (e.g. can't run `swiz state set` to escape a state
 * that blocks Bash).
 */
export function isSwizCommand(input: ToolHookInput): boolean {
  const cmd = String(input.tool_input?.command ?? "")
  return SWIZ_CMD_RE.test(cmd)
}

// ─── Placeholder subject detection ──────────────────────────────────────────

/**
 * Matches all auto-generated placeholder task subjects:
 *   - "Recovered task #N (lost during compaction)" — pretooluse-task-recovery / posttooluse-task-recovery
 *   - "Session bootstrap — describe current work"  — legacy pretooluse-require-tasks placeholder
 */
export const PLACEHOLDER_SUBJECT_RE = /^(?:recovered task|session bootstrap)\b/i

/** Returns true if the subject is an auto-generated placeholder (not real agent work). */
export function isPlaceholderSubject(subject: string): boolean {
  return PLACEHOLDER_SUBJECT_RE.test(subject.trim())
}

// ─── Action plan formatting ─────────────────────────────────────────────────
// Subset of src/action-plan.ts without agents.ts / translateToolNames support.
// Hooks that need translateToolNames must remain file-based.

/** A step can be a plain string or an array of sub-steps (recursively nested). */
export type ActionPlanItem = string | ActionPlanItem[]

/**
 * Format a numbered action plan string from a list of steps.
 * Steps can be plain strings or nested arrays for sub-step hierarchies.
 * Does NOT translate tool names (avoids agents.ts dependency).
 */
export function formatActionPlan(steps: ActionPlanItem[], options?: { header?: string }): string {
  if (steps.length === 0) return ""
  const lines = renderItems(steps, 1, "  ")
  const header = options?.header ?? "Action plan:"
  return `${header}\n${lines}\n`
}

function renderItems(items: ActionPlanItem[], startIndex: number, indent: string): string {
  const lines: string[] = []
  let index = startIndex
  for (const item of items) {
    if (typeof item === "string") {
      lines.push(`${indent}${index}. ${item}`)
      index++
    } else {
      lines.push(...renderSubItems(item, `${indent}   `))
    }
  }
  return lines.join("\n")
}

function renderSubItems(items: ActionPlanItem[], indent: string): string[] {
  const lines: string[] = []
  for (const [i, item] of items.entries()) {
    if (typeof item === "string") {
      const letter = String.fromCharCode(97 + (i % 26))
      lines.push(`${indent}${letter}. ${item}`)
    } else {
      lines.push(...renderSubItems(item, `${indent}   `))
    }
  }
  return lines
}

// ─── Native task-tool availability ───────────────────────────────────────────
// Task governance reads the native task store. Only the *native* task tools write to it, so
// when they are missing from the session registry every gate sees an empty queue and the
// remedy it prescribes ("create a task") is uncallable — an unrecoverable deadlock of the same
// class `isSwizCommand` exists to prevent. ToolSearch responses reveal which tools the session
// actually has; these helpers classify that evidence.

/** Native task tools. Bare names only — MCP equivalents do NOT write to the native store. */
export const NATIVE_TASK_TOOL_NAMES = ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"] as const

/** Every MCP tool is namespaced `mcp__<server>__<tool>`. */
const MCP_TOOL_NAME_PREFIX = "mcp__"

/**
 * True only for a bare native task tool name.
 *
 * Substring matching is wrong here: `mcp__swiz__TaskCreate` contains "TaskCreate" but writes to
 * the swiz store, not the native one. Treating it as native keeps governance enforcing against a
 * queue that can never fill.
 */
export function isNativeTaskToolName(name: string): boolean {
  if (name.startsWith(MCP_TOOL_NAME_PREFIX)) return false
  return (NATIVE_TASK_TOOL_NAMES as readonly string[]).includes(name)
}

/**
 * `present` — a native task tool was seen.
 * `absent`  — a search that would have matched one came back without it (proof, not silence).
 * `unknown` — no qualifying evidence; callers must fail open.
 */
export type NativeTaskToolAvailability = "present" | "absent" | "unknown"
const NATIVE_TASK_AVAILABILITY_CACHE_SIZE = 50

/** ToolSearch evidence as captured in `_toolSearch` by the incoming-capture JSONL summary. */
export interface ToolSearchEvidence {
  query?: string
  matches?: string[]
  totalDeferredTools?: number
}

/**
 * True for any task tool by name, native or provider-prefixed (`mcp__<server>__TaskCreate`).
 *
 * Deliberately weaker than {@link isNativeTaskToolName}: this answers "is this name a task tool?",
 * not "does this name write to the native store?". Only the former decides whether a search was
 * aimed at task tools.
 */
function isTaskToolNameForAnyProvider(name: string): boolean {
  if (isNativeTaskToolName(name)) return true
  if (!name.startsWith(MCP_TOOL_NAME_PREFIX)) return false
  const bareName = name.slice(name.lastIndexOf("__") + 2)
  return (NATIVE_TASK_TOOL_NAMES as readonly string[]).includes(bareName)
}

/**
 * True when the query itself targeted task tools, so an absence of native matches is meaningful.
 * A `select:` query names tools explicitly; a keyword query mentioning "task" would also surface
 * them, since MCP task tools rank for the same terms.
 *
 * Provider-prefixed names count here even though they are not native. A session whose only task
 * tools are MCP asks for them by their MCP names, and that search would still have returned the
 * native tools had the registry held any — so a miss is proof, not silence. Reusing the strict
 * native check for this question left exactly those sessions permanently `unknown`, keeping
 * governance enforced against a store they never write to (#825).
 */
export function toolSearchQueryTargetsTaskTools(query: string): boolean {
  const trimmed = query.trim()
  if (!trimmed) return false
  const selectPrefix = "select:"
  if (trimmed.toLowerCase().startsWith(selectPrefix)) {
    return trimmed
      .slice(selectPrefix.length)
      .split(",")
      .some((name) => isTaskToolNameForAnyProvider(name.trim()))
  }
  return /\btasks?\b/i.test(trimmed)
}

/** Classify a single ToolSearch record. */
export function classifyToolSearchTaskEvidence(
  evidence: ToolSearchEvidence | null | undefined
): NativeTaskToolAvailability {
  if (!evidence) return "unknown"
  const matches = evidence.matches
  if (!Array.isArray(matches)) return "unknown"
  if (matches.some((match) => isNativeTaskToolName(match))) return "present"
  if (!toolSearchQueryTargetsTaskTools(evidence.query ?? "")) return "unknown"
  // A search that would have matched them returned none: the registry does not have them.
  return "absent"
}

/**
 * Fold ToolSearch records into one verdict. `present` wins outright — a tool seen once exists for
 * the session — otherwise a targeted miss proves absence, and no qualifying evidence stays
 * `unknown` so callers fail open.
 */
export function resolveNativeTaskToolAvailability(
  records: Array<ToolSearchEvidence | null | undefined>
): NativeTaskToolAvailability {
  let verdict: NativeTaskToolAvailability = "unknown"
  for (const record of records) {
    const classification = classifyToolSearchTaskEvidence(record)
    if (classification === "present") return "present"
    if (classification === "absent") verdict = "absent"
  }
  return verdict
}

/** Governance may only enforce when the native tools are not known to be missing. */
export function shouldEnforceTaskGovernance(availability: NativeTaskToolAvailability): boolean {
  return availability !== "absent"
}

/**
 * The harness reports a call to a missing tool with this error, which is direct proof the tool is
 * not in the session registry.
 */
const NATIVE_TASK_TOOL_MISSING_RE =
  /No such tool available:\s*(?:TaskCreate|TaskUpdate|TaskList|TaskGet)\b/

/**
 * A native task tool actually being invoked. The quoted exact name cannot match
 * `mcp__swiz__TaskCreate`, which is the distinction the whole check rests on.
 */
const NATIVE_TASK_TOOL_USE_RE = /"name"\s*:\s*"(?:TaskCreate|TaskUpdate|TaskList|TaskGet)"/

/**
 * Resolve availability from the session transcript.
 *
 * Preferred over capture files: `transcript_path` is on every hook payload, whereas the
 * `/tmp/swiz-incoming` JSONL stream is only written by CLI dispatch and the daemon — it goes
 * stale whenever hooks run as standalone subprocesses.
 *
 * Line-level regexes avoid parsing a multi-megabyte transcript on every tool call.
 */
export async function readNativeTaskToolAvailabilityFromTranscript(
  transcriptPath: string | undefined | null
): Promise<NativeTaskToolAvailability> {
  if (!transcriptPath) return "unknown"
  try {
    const state = transcriptAvailabilityByPath.get(transcriptPath) ?? createAvailabilityState()
    const metadata = await readAppendMetadata(transcriptPath)
    if (!metadata) return "unknown"
    const update = await state.cursor.read(transcriptPath, metadata)
    const lines =
      update.kind === "cold" ? (await Bun.file(transcriptPath).text()).split("\n") : update.lines
    if (update.kind === "cold") {
      state.verdict = "unknown"
      state.cursor.reset(metadata)
    }
    state.verdict = applyTranscriptEvidence(state.verdict, lines)
    transcriptAvailabilityByPath.set(transcriptPath, state)
    return state.verdict
  } catch {
    return "unknown"
  }
}

/** Extract this session's `_toolSearch` records from one capture JSONL file. */
async function readToolSearchEvidenceFile(
  path: string,
  sessionId: string
): Promise<NativeTaskToolAvailability> {
  const file = Bun.file(path)
  if (!(await file.exists())) return "unknown"
  const metadata = await readAppendMetadata(path)
  if (!metadata) return "unknown"
  const state = captureAvailabilityByPath.get(path) ?? createCaptureAvailabilityState()
  const update = await state.cursor.read(path, metadata)
  const lines = await readCaptureCursorLines(file, state, update.kind, update.lines, metadata)
  for (const line of lines) applyToolSearchCaptureLine(line, state)
  captureAvailabilityByPath.set(path, state)
  return state.verdicts.get(sessionId) ?? "unknown"
}

/**
 * Resolve native task-tool availability for a session from captured ToolSearch evidence.
 * Any failure — missing directory, unreadable file, no matching session — yields `unknown`,
 * so governance keeps enforcing unless absence is positively proven.
 */
/**
 * Resolved verdicts are cached per session: a session's tool registry is fixed for its lifetime.
 * `unknown` is never cached — later ToolSearch calls may still settle the question.
 */
const nativeTaskToolAvailabilityBySession = new LRUCache<string, NativeTaskToolAvailability>({
  max: NATIVE_TASK_AVAILABILITY_CACHE_SIZE,
})

interface AvailabilityState {
  cursor: JsonlAppendCursor
  verdict: NativeTaskToolAvailability
}

interface CaptureAvailabilityState {
  cursor: JsonlAppendCursor
  verdicts: LRUCache<string, NativeTaskToolAvailability>
}

const transcriptAvailabilityByPath = new LRUCache<string, AvailabilityState>({
  max: NATIVE_TASK_AVAILABILITY_CACHE_SIZE,
})
const captureAvailabilityByPath = new LRUCache<string, CaptureAvailabilityState>({
  max: NATIVE_TASK_AVAILABILITY_CACHE_SIZE,
})

function createAvailabilityState(): AvailabilityState {
  return { cursor: new JsonlAppendCursor(), verdict: "unknown" }
}

function createCaptureAvailabilityState(): CaptureAvailabilityState {
  return {
    cursor: new JsonlAppendCursor(),
    verdicts: new LRUCache({ max: NATIVE_TASK_AVAILABILITY_CACHE_SIZE }),
  }
}

async function readCaptureCursorLines(
  file: Bun.BunFile,
  state: CaptureAvailabilityState,
  kind: "hit" | "append" | "cold",
  appendedLines: string[],
  metadata: JsonlAppendMetadata
): Promise<string[]> {
  if (kind !== "cold") return appendedLines
  state.verdicts.clear()
  state.cursor.reset(metadata)
  return (await file.text()).split("\n")
}

function applyToolSearchCaptureLine(line: string, state: CaptureAvailabilityState): void {
  if (!line.includes('"_toolSearch"')) return
  try {
    const record = JSON.parse(line) as Record<string, any>
    if (typeof record.session_id !== "string" || !record._toolSearch) return
    const current = state.verdicts.get(record.session_id) ?? "unknown"
    const next = resolveNativeTaskToolAvailability([currentEvidence(current), record._toolSearch])
    state.verdicts.set(record.session_id, next)
  } catch {
    // Malformed capture lines carry no evidence; absence of proof is not proof of absence.
  }
}

async function readAppendMetadata(path: string): Promise<JsonlAppendMetadata | null> {
  try {
    const stat = await Bun.file(path).stat()
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      dev: (stat as { dev?: number }).dev,
      ino: (stat as { ino?: number }).ino,
    }
  } catch {
    return null
  }
}

function applyTranscriptEvidence(
  existing: NativeTaskToolAvailability,
  lines: string[]
): NativeTaskToolAvailability {
  let verdict = existing
  for (const line of lines) {
    if (!line.includes("Task")) continue
    if (NATIVE_TASK_TOOL_USE_RE.test(line)) return "present"
    if (NATIVE_TASK_TOOL_MISSING_RE.test(line)) verdict = "absent"
  }
  return verdict
}

function currentEvidence(verdict: NativeTaskToolAvailability): ToolSearchEvidence | null {
  if (verdict === "present") return { query: "select:TaskCreate", matches: ["TaskCreate"] }
  if (verdict === "absent") return { query: "select:TaskCreate", matches: [] }
  return null
}

/** Test seam: drop memoized verdicts. */
export function resetNativeTaskToolAvailabilityCache(): void {
  nativeTaskToolAvailabilityBySession.clear()
  transcriptAvailabilityByPath.clear()
  captureAvailabilityByPath.clear()
}

export async function readNativeTaskToolAvailability(
  sessionId: string | undefined | null,
  dir: string,
  transcriptPath?: string | null
): Promise<NativeTaskToolAvailability> {
  if (!sessionId) return "unknown"
  const cached = nativeTaskToolAvailabilityBySession.get(sessionId)
  if (cached) return cached
  const fromTranscript = await readNativeTaskToolAvailabilityFromTranscript(transcriptPath)
  if (fromTranscript !== "unknown") {
    nativeTaskToolAvailabilityBySession.set(sessionId, fromTranscript)
    return fromTranscript
  }
  try {
    const perFile = await Promise.all(
      ["postToolUse", "preToolUse"].map((event) =>
        readToolSearchEvidenceFile(`${dir}/${event}.jsonl`, sessionId)
      )
    )
    const availability = resolveNativeTaskToolAvailability(perFile.map(currentEvidence))
    if (availability !== "unknown") {
      nativeTaskToolAvailabilityBySession.set(sessionId, availability)
    }
    return availability
  } catch {
    return "unknown"
  }
}

// ─── Command/Execution Timing Hook Helpers ────────────────────────────────────

/**
 * Returns true if the executed shell tool command represents a background task.
 */
export function isBackgroundCommand(hookInput: PostToolHookInput, command: string): boolean {
  return (
    hookInput.tool_input?.run_in_background === true ||
    /\s+&\s*$|\s+&\s/.test(command) ||
    (typeof hookInput.tool_response === "string" &&
      /running in background|background task/i.test(hookInput.tool_response))
  )
}

interface TokenizeState {
  quote: string | null
  token: string
  tokens: string[]
}

function processQuotedChar(state: TokenizeState, segment: string, index: number): number {
  const ch = segment[index]!
  if (ch === state.quote) {
    state.quote = null
    return index
  }
  if (state.quote === '"' && ch === "\\" && index + 1 < segment.length) {
    state.token += segment[index + 1]!
    return index + 1
  }
  state.token += ch
  return index
}

function processUnquotedChar(state: TokenizeState, segment: string, index: number): number {
  const ch = segment[index]!
  if (ch === '"' || ch === "'") {
    state.quote = ch
    return index
  }
  if (ch === "\\" && index + 1 < segment.length) {
    state.token += segment[index + 1]!
    return index + 1
  }
  if (ch === " " || ch === "\t") {
    if (state.token) {
      state.tokens.push(state.token)
      state.token = ""
    }
    return index
  }
  state.token += ch
  return index
}

/**
 * Basic shell tokenizer that splits on whitespace while respecting single/double quotes.
 */
export function tokenize(segment: string): string[] {
  const state: TokenizeState = { quote: null, token: "", tokens: [] }

  for (let i = 0; i < segment.length; i++) {
    i = state.quote ? processQuotedChar(state, segment, i) : processUnquotedChar(state, segment, i)
  }
  if (state.token) {
    state.tokens.push(state.token)
  }
  return state.tokens
}
