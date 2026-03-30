/**
 * Hook execution engine — runs individual hooks, classifies responses,
 * and implements the three dispatch strategies (preToolUse, blocking, context).
 *
 * Extracted from src/commands/dispatch.ts (issue #84).
 */

import { AsyncLocalStorage } from "node:async_hooks"
import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import { hookBaseSchema } from "../../hooks/schemas.ts"
import { debugLog } from "../debug.ts"
import { SwizHookExit, withInlineSwizHookRun } from "../inline-hook-context.ts"
import { evalCondition, type HookGroup, hookIdentifier, isInlineHookDef } from "../manifest.ts"
import type { SwizHook } from "../SwizHook.ts"
import { swizDispatchLogPath } from "../temp-paths.ts"
import {
  isEditTool,
  isNotebookTool,
  isShellTool,
  isTaskCreateTool,
  isTaskGetTool,
  isTaskListTool,
  isTaskTool,
  isTaskUpdateTool,
  isWriteTool,
} from "../tool-matchers.ts"
import { isWithinCooldown, markHookCooldown } from "./filters.ts"
import { getWorkerPool } from "./worker-pool.ts"
import {
  classifyHookOutput,
  DEFAULT_TIMEOUT,
  extractCallerEnv,
  extractPayloadCwd,
  HOOKS_DIR,
  SIGKILL_GRACE_MS,
} from "./worker-types.ts"

// ─── Module-level constants ─────────────────────────────────────────────────

const LOG_PATH = swizDispatchLogPath()

// Re-export for barrel (index.ts) and downstream consumers.
export { classifyHookOutput, DEFAULT_TIMEOUT }

/** Slow-hook threshold: hooks taking longer than this are flagged in the log.
 *  Configurable via SWIZ_SLOW_HOOK_THRESHOLD_MS env var. Default: 3 seconds. */
const SLOW_HOOK_THRESHOLD_MS = Number(process.env.SWIZ_SLOW_HOOK_THRESHOLD_MS) || 3_000

// ─── Hook property accessors ───────────────────────────────────────────────
// Consolidate the pattern of extracting properties that differ between inline
// and subprocess hooks: isInlineHookDef(hook) ? hook.hook.property : hook.property

function getHookTimeout(hook: HookDef): number | undefined {
  return isInlineHookDef(hook) ? hook.hook.timeout : hook.timeout
}

function getHookCondition(hook: HookDef): string | undefined {
  return isInlineHookDef(hook) ? hook.hook.condition : hook.condition
}

function getHookCooldownSeconds(hook: HookDef): number | undefined {
  return isInlineHookDef(hook) ? hook.hook.cooldownSeconds : hook.cooldownSeconds
}

function getHookCooldownMode(hook: HookDef): "block-only" | "always" | undefined {
  return isInlineHookDef(hook) ? hook.hook.cooldownMode : hook.cooldownMode
}

function isHookAsync(hook: HookDef): boolean {
  return isInlineHookDef(hook) ? !!hook.hook.async : !!hook.async
}

function getHookAsyncMode(hook: HookDef): "block-until-complete" | "fire-and-forget" | undefined {
  return isInlineHookDef(hook) ? hook.hook.asyncMode : hook.asyncMode
}

// ─── Hook execution types ────────────────────────────────────────────────────

export type HookStatus =
  | "ok"
  | "no-output"
  | "allow-with-reason"
  | "deny"
  | "block"
  | "slow"
  | "timeout"
  | "invalid-json"
  | "invalid-schema"
  | "error"
  | "skipped"
  | "aborted"

export type SkipReason = "condition-false" | "cooldown-active"

export interface HookExecution {
  file: string
  matcher?: string
  startTime: number
  endTime: number
  durationMs: number
  configuredTimeoutSec: number
  status: HookStatus
  skipReason?: SkipReason
  exitCode: number | null
  stdoutSnippet: string // bounded at 500 chars
  stderrSnippet: string // bounded at 500 chars
}

type HookDef = HookGroup["hooks"][number]

// ─── Debug logger ───────────────────────────────────────────────────────────

/** Per-dispatch log buffer. When a dispatch is active, lines accumulate here
 *  and are flushed as a single appendFile at the end. Falls back to per-line
 *  writes when called outside a dispatch context (e.g. direct test calls). */
const _logBufferStorage = new AsyncLocalStorage<string[]>()

export function log(msg: string): void {
  const buffer = _logBufferStorage.getStore()
  if (buffer) {
    buffer.push(`${msg}\n`)
  } else {
    appendFile(LOG_PATH, `${msg}\n`).catch(() => {})
  }
  debugLog(msg)
}

/**
 * Run `fn` inside a per-dispatch log buffer context.
 * All `log()` calls within `fn` (including nested async work that inherits
 * the async context) are accumulated and flushed as a single `appendFile`
 * when `fn` resolves or rejects — regardless of early returns or exceptions.
 */
export async function withLogBuffer<T>(fn: () => Promise<T>): Promise<T> {
  const buffer: string[] = []
  return _logBufferStorage.run(buffer, async () => {
    try {
      return await fn()
    } finally {
      if (buffer.length > 0) {
        appendFile(LOG_PATH, buffer.join("")).catch(() => {})
      }
    }
  })
}

export function logHeader(
  event: string,
  hookEventName: string,
  toolName?: string,
  trigger?: string
): void {
  const ts = new Date().toISOString()
  const pid = process.pid
  log(`\n── ${ts} ── ${event} (hookEventName=${hookEventName}, pid=${pid}) ──`)
  if (toolName) log(`   tool: ${toolName}`)
  if (trigger) log(`   trigger: ${trigger}`)
}

function formatHookTarget(file: string, matcher?: string): string {
  return `${file}${matcher ? ` [${matcher}]` : ""}`
}

// ─── Performance logging ─────────────────────────────────────────────────────

/**
 * Log a slow-hook warning when durationMs exceeds thresholdMs.
 * Returns true when the hook is considered slow, false otherwise.
 * Exported for unit testing.
 */
export function logSlowHook(
  file: string,
  durationMs: number,
  thresholdMs: number = SLOW_HOOK_THRESHOLD_MS
): boolean {
  if (durationMs <= thresholdMs) return false
  log(`   ⚠ SLOW HOOK: ${file} took ${durationMs}ms (threshold: ${thresholdMs}ms)`)
  return true
}

/** Log a summary of all hooks considered slow. Exported for strategies. */
export function logSlowHookSummary(executions: HookExecution[]): void {
  const slowHooks = executions.filter((e) => e.status === "slow").map((e) => e.file)
  if (slowHooks.length > 0) {
    log(`   ⚠ slow-hook summary (${slowHooks.length}): ${slowHooks.join(", ")}`)
  }
}

// ─── Cross-agent matcher ────────────────────────────────────────────────────

export function toolMatchesToken(toolName: string, token: string): boolean {
  const toolMatchers = [
    isShellTool,
    isEditTool,
    isWriteTool,
    isNotebookTool,
    isTaskCreateTool,
    isTaskUpdateTool,
    isTaskListTool,
    isTaskGetTool,
  ]
  for (const matcher of toolMatchers) {
    if (matcher(toolName) && matcher(token)) return true
  }

  // Broad "Task" family: only when token or toolName is the umbrella "Task"
  if (token === "Task" && isTaskTool(toolName)) return true
  if (toolName === "Task" && isTaskTool(token)) return true
  // Unknown tools only match exact
  return toolName === token
}

export function groupMatches(
  group: HookGroup,
  toolName: string | undefined,
  trigger: string | undefined
): boolean {
  if (!group.matcher) return true
  // SessionStart uses trigger types (startup/compact) not tool names
  if (trigger !== undefined) return group.matcher === trigger
  if (!toolName) return false
  return group.matcher.split("|").some((part) => toolMatchesToken(toolName, part.trim()))
}

// ─── Hook execution ─────────────────────────────────────────────────────────

export interface HookRunResult {
  parsed: Record<string, unknown> | null
  execution: HookExecution
}

function getConfiguredTimeoutSec(timeoutSec?: number): number {
  const baseTimeoutSec = timeoutSec ?? DEFAULT_TIMEOUT
  const testTimeoutSec = process.env.SWIZ_TEST_HOOK_TIMEOUT_SEC
    ? parseInt(process.env.SWIZ_TEST_HOOK_TIMEOUT_SEC, 10)
    : 0
  return Math.max(baseTimeoutSec, testTimeoutSec)
}

interface TimeoutState {
  timer: ReturnType<typeof setTimeout>
  sigkillTimer: ReturnType<typeof setTimeout> | undefined
  timedOut: boolean
}

function setupTimeoutHandling(
  proc: ReturnType<typeof Bun.spawn>,
  file: string,
  configuredTimeoutSec: number
): TimeoutState {
  const state: TimeoutState = { timer: undefined!, sigkillTimer: undefined, timedOut: false }
  state.timer = setTimeout(() => {
    state.timedOut = true
    log(`   ⏱ TIMEOUT (${configuredTimeoutSec}s) — SIGTERM ${file}`)
    proc.kill("SIGTERM")
    state.sigkillTimer = setTimeout(() => {
      log(`   ⏱ SIGKILL escalation — ${file} did not exit after SIGTERM`)
      proc.kill("SIGKILL")
    }, SIGKILL_GRACE_MS)
  }, configuredTimeoutSec * 1000)
  return state
}

function setupAbortListener(
  proc: ReturnType<typeof Bun.spawn>,
  file: string,
  signal?: AbortSignal
): { onAbort: () => void; cleanup: () => void } {
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined
  const onAbort = () => {
    log(`   ⊘ ABORTED ${file} (another hook denied)`)
    proc.kill("SIGTERM")
    sigkillTimer = setTimeout(() => {
      proc.kill("SIGKILL")
    }, SIGKILL_GRACE_MS)
  }
  signal?.addEventListener("abort", onAbort, { once: true })
  return {
    onAbort,
    cleanup: () => {
      signal?.removeEventListener("abort", onAbort)
      if (sigkillTimer) clearTimeout(sigkillTimer)
    },
  }
}

function logHookOutput(trimmed: string, exitCode: number | null, stderrTrimmed: string): void {
  if (stderrTrimmed) log(`   stderr: ${stderrTrimmed.slice(0, 500)}`)
  if (exitCode !== 0) log(`   exit=${exitCode}`)
  if (trimmed) log(`   stdout: ${trimmed.slice(0, 500)}`)
}

function buildAbortedResult(
  file: string,
  startTime: number,
  endTime: number,
  configuredTimeoutSec: number,
  exitCode: number | null
): HookRunResult {
  return {
    parsed: null,
    execution: {
      file,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      configuredTimeoutSec,
      status: "aborted",
      exitCode,
      stdoutSnippet: "",
      stderrSnippet: "",
    },
  }
}

/** Build the env object for a hook subprocess by merging caller env from
 *  the enriched payload with the current process env. */
function buildHookEnv(payloadStr: string): Record<string, string | undefined> | undefined {
  const callerEnv = extractCallerEnv(payloadStr)
  return callerEnv ? { ...process.env, ...callerEnv } : undefined
}

export async function runHook(
  file: string,
  payloadStr: string,
  timeoutSec?: number,
  signal?: AbortSignal
): Promise<HookRunResult> {
  // If already aborted before we even spawn, return immediately.
  if (signal?.aborted) {
    const now = Date.now()
    return buildAbortedResult(file, now, now, timeoutSec ?? DEFAULT_TIMEOUT, null)
  }

  const cmd = file.endsWith(".ts") ? ["bun", join(HOOKS_DIR, file)] : [join(HOOKS_DIR, file)]
  const startTime = Date.now()
  const configuredTimeoutSec = getConfiguredTimeoutSec(timeoutSec)

  const spawnCwd = extractPayloadCwd(payloadStr)

  const proc = Bun.spawn(cmd, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: spawnCwd,
    env: buildHookEnv(payloadStr),
  })

  await proc.stdin.write(payloadStr)
  await proc.stdin.end()

  let aborted = false

  const timeoutState = setupTimeoutHandling(proc, file, configuredTimeoutSec)
  const abortHandler = setupAbortListener(proc, file, signal)

  signal?.addEventListener(
    "abort",
    () => {
      aborted = true
    },
    { once: true }
  )

  const [output, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  clearTimeout(timeoutState.timer)
  if (timeoutState.sigkillTimer) clearTimeout(timeoutState.sigkillTimer)
  abortHandler.cleanup()

  const endTime = Date.now()
  const exitCode = proc.exitCode
  const trimmed = output.trim()
  const stderrTrimmed = stderr.trim()

  logHookOutput(trimmed, exitCode, stderrTrimmed)

  // If aborted, treat as a clean skip — don't classify output from a killed process.
  if (aborted) {
    return buildAbortedResult(file, startTime, endTime, configuredTimeoutSec, exitCode ?? null)
  }

  const { parsed, status } = classifyHookOutput({
    timedOut: timeoutState.timedOut,
    trimmed,
    exitCode,
  })

  const execution: HookExecution = {
    file,
    startTime,
    endTime,
    durationMs: endTime - startTime,
    configuredTimeoutSec,
    status: status as HookStatus,
    exitCode: exitCode ?? null,
    stdoutSnippet: trimmed.slice(0, 500),
    stderrSnippet: stderrTrimmed.slice(0, 500),
  }

  return { parsed, execution }
}

function createSkippedExecution(
  hook: HookDef,
  matcher: string | undefined,
  skipReason: SkipReason
): HookExecution {
  const now = Date.now()
  const timeoutSec = getHookTimeout(hook) ?? DEFAULT_TIMEOUT
  return {
    file: hookIdentifier(hook),
    ...(matcher && { matcher }),
    startTime: now,
    endTime: now,
    durationMs: 0,
    configuredTimeoutSec: timeoutSec,
    status: "skipped",
    skipReason,
    exitCode: null,
    stdoutSnippet: "",
    stderrSnippet: "",
  }
}

async function tryRecordSkippedHook(
  hook: HookDef,
  matcher: string | undefined,
  cwd: string,
  executions: HookExecution[]
): Promise<boolean> {
  const id = hookIdentifier(hook)
  const condition = getHookCondition(hook)
  if (!(await evalCondition(condition))) {
    log(`   ⏭ ${id} [condition false, skipping]`)
    executions.push(createSkippedExecution(hook, matcher, "condition-false"))
    return true
  }
  const cooldownSeconds = getHookCooldownSeconds(hook)
  if (cooldownSeconds && (await isWithinCooldown(id, cooldownSeconds, cwd))) {
    log(`   ⏭ ${id} [cooldown active, skipping]`)
    executions.push(createSkippedExecution(hook, matcher, "cooldown-active"))
    return true
  }
  return false
}

/**
 * Finalize a hook execution record: apply matcher, detect slow hooks, and
 * start the cooldown timer when applicable.
 *
 * Default `cooldownMode` is `block-only`: timer starts only after deny/block.
 * With `cooldownMode: "always"`, the timer starts after every run (including
 * allow / context-only), as long as the hook returns normally — inline hooks
 * must not call `process.exit` before returning, or cooldown will not record.
 */
function finalizeExecution(
  execution: HookExecution,
  matcher: string | undefined,
  hook: HookDef,
  cwd: string,
  parsed: Record<string, unknown> | null
): HookExecution {
  if (matcher) execution.matcher = matcher
  if (execution.status === "ok" && logSlowHook(execution.file, execution.durationMs)) {
    execution.status = "slow"
  }

  const cooldownSeconds = getHookCooldownSeconds(hook)
  if (!cooldownSeconds) return execution

  const cooldownMode = getHookCooldownMode(hook)
  const alwaysMode = cooldownMode === "always"
  const blockResult = parsed !== null && (isDeny(parsed) || isBlock(parsed))
  if (alwaysMode || blockResult) {
    void markHookCooldown(hookIdentifier(hook), cwd)
  }
  return execution
}

/** Write the final hook response to process.stdout. Exported for strategies. */
export function writeResponse(response: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(response)}\n`)
}

// ─── Response classification ────────────────────────────────────────────────

/** Safely extract hookSpecificOutput from a response. */
function getHookSpecificOutput(resp: Record<string, unknown>): Record<string, unknown> | undefined {
  const hso = resp.hookSpecificOutput
  return hso && typeof hso === "object" && !Array.isArray(hso)
    ? (hso as Record<string, unknown>)
    : undefined
}

/**
 * PreToolUse denial: checks `permissionDecision` in hookSpecificOutput
 * (the PreToolUse-specific pattern) and falls back to top-level `decision`
 * for hooks that use the generic deny/block format.
 */
export function isDeny(resp: Record<string, unknown>): boolean {
  const hso = getHookSpecificOutput(resp)
  if (hso?.permissionDecision === "deny") return true
  if (resp.decision === "deny" || resp.decision === "block") return true
  if (resp.continue === false) return true
  return hso?.decision === "deny" || hso?.decision === "block" || false
}

export function isAllowWithReason(resp: Record<string, unknown>): boolean {
  const hso = getHookSpecificOutput(resp)
  return hso?.permissionDecision === "allow" && typeof hso?.permissionDecisionReason === "string"
}

export function extractAllowReason(resp: Record<string, unknown>): string | null {
  const hso = getHookSpecificOutput(resp)
  if (hso?.permissionDecision === "allow" && typeof hso?.permissionDecisionReason === "string") {
    return hso.permissionDecisionReason as string
  }
  return null
}

/**
 * Stop/PostToolUse block: checks top-level `decision` and `continue`
 * (the blocking-strategy pattern). Does not check `permissionDecision`
 * which is PreToolUse-specific.
 */
export function isBlock(resp: Record<string, unknown>): boolean {
  if (resp.decision === "block" || resp.decision === "deny") return true
  if (resp.continue === false) return true
  const hso = getHookSpecificOutput(resp)
  return hso?.decision === "block" || hso?.decision === "deny" || false
}

export function extractContext(resp: Record<string, unknown>): string | null {
  const hso = getHookSpecificOutput(resp)
  const ctx = hso?.additionalContext ?? resp.systemMessage
  return typeof ctx === "string" ? ctx : null
}

// ─── Concurrent hook runner ──────────────────────────────────────────────────

/**
 * Flat entry representing one synchronous hook with its group context,
 * used by the concurrent fan-out helpers.
 */
export interface HookEntry {
  hook: HookDef
  matcher: string | undefined
}

/** True when the hook runs in the sync pipeline (non-async or `async` + block-until-complete). */
export function runsInSyncPipeline(hook: HookDef): boolean {
  if (!isHookAsync(hook)) return true
  return getHookAsyncMode(hook) === "block-until-complete"
}

/** True when the hook is async and should use `launchAsyncHooks` (fire-and-forget path). */
export function isAsyncFireAndForgetHook(hook: HookDef): boolean {
  if (!isHookAsync(hook)) return false
  return getHookAsyncMode(hook) !== "block-until-complete"
}

/** Collect all sync hooks from all groups into a flat ordered list. Exported for unit tests. */
export function flatSyncHooks(groups: HookGroup[]): HookEntry[] {
  const entries: HookEntry[] = []
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (runsInSyncPipeline(hook)) entries.push({ hook, matcher: group.matcher })
    }
  }
  return entries
}

/**
 * Execute an inline SwizHook in-process. Parses the JSON payload, calls
 * hook.run(), and wraps the result in a HookRunResult — same shape as the
 * subprocess path so strategies need no special-casing.
 */
async function runInlineHook(
  hook: SwizHook,
  payloadStr: string,
  signal?: AbortSignal
): Promise<HookRunResult> {
  if (signal?.aborted) {
    const now = Date.now()
    return buildAbortedResult(hook.name, now, now, hook.timeout ?? DEFAULT_TIMEOUT, null)
  }

  const startTime = Date.now()
  const configuredTimeoutSec = getConfiguredTimeoutSec(hook.timeout)
  const { parsed, status } = await executeInlineHookWithErrorHandling(hook, payloadStr)
  const endTime = Date.now()

  return {
    parsed,
    execution: {
      file: hook.name,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      configuredTimeoutSec,
      status,
      exitCode: status === "error" ? 1 : 0,
      stdoutSnippet: parsed ? JSON.stringify(parsed).slice(0, 500) : "",
      stderrSnippet: "",
    },
  }
}

/** Helper to isolate error handling and parsing logic from runInlineHook. */
async function executeInlineHookWithErrorHandling(
  hook: SwizHook,
  payloadStr: string
): Promise<{ parsed: Record<string, unknown> | null; status: HookStatus }> {
  try {
    const input = JSON.parse(payloadStr)
    const validation = hookBaseSchema.safeParse(input)
    if (!validation.success) {
      throw new Error(`Invalid hook input: ${validation.error}`)
    }
    const output = await withInlineSwizHookRun(async () => hook.run(input))
    if (output && Object.keys(output).length > 0) {
      return { parsed: output as Record<string, unknown>, status: "ok" }
    }
    return { parsed: null, status: "no-output" }
  } catch (err) {
    if (err instanceof SwizHookExit) {
      return { parsed: err.output as Record<string, unknown>, status: "ok" }
    }
    log(`   ⚠ ${hook.name} [inline error: ${err}]`)
    return { parsed: null, status: "error" }
  }
}

/** Helper to create an aborted HookExecution with the right timeout value. */
function createAbortedExecution(
  id: string,
  hook: HookDef,
  now: number = Date.now()
): HookExecution {
  const timeoutSec = getHookTimeout(hook) ?? DEFAULT_TIMEOUT
  return {
    file: id,
    startTime: now,
    endTime: now,
    durationMs: 0,
    configuredTimeoutSec: timeoutSec,
    status: "aborted",
    exitCode: null,
    stdoutSnippet: "",
    stderrSnippet: "",
  }
}

/**
 * Run a single hook entry concurrently: first check skip conditions, then
 * execute the hook if not skipped. Returns the execution record and parsed
 * response (null when skipped or no valid JSON).
 * Exported for use in strategy implementations.
 */
export async function runEntry(
  entry: HookEntry,
  payloadStr: string,
  cwd: string,
  signal?: AbortSignal
): Promise<{
  execution: HookExecution
  parsed: Record<string, unknown> | null
}> {
  const { hook, matcher } = entry
  const id = hookIdentifier(hook)

  // Check abort before skip-condition evaluation to avoid unnecessary work.
  if (signal?.aborted) {
    return { execution: createAbortedExecution(id, hook), parsed: null }
  }

  const skipExecs: HookExecution[] = []
  if (await tryRecordSkippedHook(hook, matcher, cwd, skipExecs)) {
    return { execution: skipExecs[0]!, parsed: null }
  }

  log(`   → ${formatHookTarget(id, matcher)}`)

  if (isInlineHookDef(hook)) {
    const { parsed, execution } = await runInlineHook(hook.hook, payloadStr, signal)
    finalizeExecution(execution, matcher, hook, cwd, parsed)
    return { execution, parsed }
  }

  const { parsed, execution } = await runHook(hook.file, payloadStr, hook.timeout, signal)
  finalizeExecution(execution, matcher, hook, cwd, parsed)
  return { execution, parsed }
}

// ─── Dispatch strategy helpers ───────────────────────────────────────────────

/** Fire async hooks — fire-and-forget in CLI, awaited with timeout in daemon.
 *  When a dispatch-level abort signal is provided, in-flight daemon-context
 *  hooks are killed via the worker pool's abort propagation. */
function scheduleAsyncHookEntry(
  hook: HookDef,
  payloadStr: string,
  ctx: {
    pool: ReturnType<typeof getWorkerPool> | null
    daemonContext: boolean | undefined
    signal: AbortSignal | undefined
    promises: Promise<void>[]
  }
): void {
  const { pool, daemonContext, signal, promises } = ctx
  const id = hookIdentifier(hook)

  if (isInlineHookDef(hook)) {
    // Inline async hooks run in-process — no worker pool needed.
    log(`   → ${id} [async, inline]`)
    const p = runInlineHook(hook.hook, payloadStr, signal)
      .then(() => {})
      .catch((err) => {
        log(`   ⚠ ${id} [async inline error: ${err}]`)
      })
    if (daemonContext) promises.push(p)
    return
  }

  const timeout = hook.timeout ?? DEFAULT_TIMEOUT
  if (daemonContext && pool) {
    log(`   → ${id} [async, daemon-awaited]`)
    const p = pool
      .runHook(hook.file, payloadStr, timeout, signal)
      .then(() => {})
      .catch((err) => {
        log(`   ⚠ ${id} [async error: ${err}]`)
      })
    promises.push(p)
  } else {
    log(`   → ${id} [async, fire-and-forget]`)
    runHook(hook.file, payloadStr, hook.timeout, signal)
      .then(() => {})
      .catch(() => {})
  }
}

export async function launchAsyncHooks(
  groups: HookGroup[],
  payloadStr: string,
  daemonContext?: boolean,
  signal?: AbortSignal
): Promise<void> {
  // Flatten all async hooks across groups for concurrent condition evaluation.
  type AsyncEntry = { hook: HookDef; id: string }
  const asyncEntries: AsyncEntry[] = groups.flatMap((group) =>
    group.hooks.filter(isAsyncFireAndForgetHook).map((h) => ({ hook: h, id: hookIdentifier(h) }))
  )
  if (asyncEntries.length === 0) return

  // Evaluate all conditions concurrently instead of sequentially.
  const conditionResults = await Promise.all(
    asyncEntries.map(({ hook }) =>
      evalCondition(isInlineHookDef(hook) ? hook.hook.condition : hook.condition)
    )
  )

  const promises: Promise<void>[] = []

  // In daemon context, use the worker pool for parallel execution — workers
  // stay alive across requests. In CLI context, use runHook directly —
  // Worker threads would keep the short-lived CLI process alive, causing hangs.
  const pool = daemonContext ? getWorkerPool() : null
  if (pool) await pool.initialize()

  for (let i = 0; i < asyncEntries.length; i++) {
    const { hook, id } = asyncEntries[i]!
    if (!conditionResults[i]) {
      log(`   ⏭ ${id} [condition false, skipping]`)
      continue
    }
    if (signal?.aborted) {
      log(`   ⏭ ${id} [async, dispatch aborted]`)
      continue
    }
    scheduleAsyncHookEntry(hook, payloadStr, {
      pool,
      daemonContext,
      signal,
      promises,
    })
  }
  if (daemonContext && promises.length > 0) {
    log(`   awaiting ${promises.length} async hook(s) in daemon context`)
    await Promise.all(promises)
  }
}
