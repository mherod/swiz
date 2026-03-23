/**
 * Hook execution engine — runs individual hooks, classifies responses,
 * and implements the three dispatch strategies (preToolUse, blocking, context).
 *
 * Extracted from src/commands/dispatch.ts (issue #84).
 */

import { AsyncLocalStorage } from "node:async_hooks"
import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import { debugLog } from "../debug.ts"
import { evalCondition, type HookGroup } from "../manifest.ts"
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

// ─── Module-level constants ─────────────────────────────────────────────────

const SWIZ_ROOT = join(import.meta.dir, "..", "..")
const HOOKS_DIR = join(SWIZ_ROOT, "hooks")
const LOG_PATH = swizDispatchLogPath()
export const DEFAULT_TIMEOUT = 10 // seconds

/** Grace period before escalating SIGTERM → SIGKILL on timed-out hooks (ms). */
const SIGKILL_GRACE_MS = 3_000

/** Slow-hook threshold: hooks taking longer than this are flagged in the log.
 *  Configurable via SWIZ_SLOW_HOOK_THRESHOLD_MS env var. Default: 3 seconds. */
const SLOW_HOOK_THRESHOLD_MS = Number(process.env.SWIZ_SLOW_HOOK_THRESHOLD_MS) || 3_000

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

// ─── Hook output classification ──────────────────────────────────────────────

/**
 * Pure classification of raw hook output into a HookStatus and parsed JSON.
 * Extracted from runHook so it can be unit-tested without spawning subprocesses.
 */
export function classifyHookOutput({
  timedOut,
  trimmed,
  exitCode,
}: {
  timedOut: boolean
  trimmed: string
  exitCode: number | null
}): { parsed: Record<string, unknown> | null; status: HookStatus } {
  if (timedOut) return { parsed: null, status: "timeout" }
  if (!trimmed) return { parsed: null, status: exitCode !== 0 ? "error" : "no-output" }
  try {
    return { parsed: JSON.parse(trimmed) as Record<string, unknown>, status: "ok" }
  } catch {
    // Stdout may contain non-JSON prefix text before the actual JSON object.
    // Attempt to extract the last JSON object from the output.
    const lastBrace = trimmed.lastIndexOf("{")
    if (lastBrace > 0) {
      try {
        const candidate = trimmed.slice(lastBrace)
        return { parsed: JSON.parse(candidate) as Record<string, unknown>, status: "ok" }
      } catch {
        // Fall through to invalid-json
      }
    }
    return { parsed: null, status: "invalid-json" }
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
  if (toolName === token) return true
  return false
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

function setupTimeoutHandling(
  proc: ReturnType<typeof Bun.spawn>,
  file: string,
  configuredTimeoutSec: number
): {
  timer: ReturnType<typeof setTimeout>
  sigkillTimer: ReturnType<typeof setTimeout> | undefined
} {
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => {
    log(`   ⏱ TIMEOUT (${configuredTimeoutSec}s) — SIGTERM ${file}`)
    proc.kill("SIGTERM")
    sigkillTimer = setTimeout(() => {
      log(`   ⏱ SIGKILL escalation — ${file} did not exit after SIGTERM`)
      proc.kill("SIGKILL")
    }, SIGKILL_GRACE_MS)
  }, configuredTimeoutSec * 1000)
  return { timer, sigkillTimer }
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

  const proc = Bun.spawn(cmd, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

  void proc.stdin.write(payloadStr)
  void proc.stdin.end()

  let timedOut = false
  let aborted = false

  const timeoutHandler = setupTimeoutHandling(proc, file, configuredTimeoutSec)
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

  clearTimeout(timeoutHandler.timer)
  if (timeoutHandler.sigkillTimer) {
    clearTimeout(timeoutHandler.sigkillTimer)
    timedOut = true
  }
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

  const { parsed, status } = classifyHookOutput({ timedOut, trimmed, exitCode })

  const execution: HookExecution = {
    file,
    startTime,
    endTime,
    durationMs: endTime - startTime,
    configuredTimeoutSec,
    status,
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
  return {
    file: hook.file,
    ...(matcher && { matcher }),
    startTime: now,
    endTime: now,
    durationMs: 0,
    configuredTimeoutSec: hook.timeout ?? DEFAULT_TIMEOUT,
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
  if (!(await evalCondition(hook.condition))) {
    log(`   ⏭ ${hook.file} [condition false, skipping]`)
    executions.push(createSkippedExecution(hook, matcher, "condition-false"))
    return true
  }
  if (hook.cooldownSeconds && (await isWithinCooldown(hook.file, hook.cooldownSeconds, cwd))) {
    log(`   ⏭ ${hook.file} [cooldown active, skipping]`)
    executions.push(createSkippedExecution(hook, matcher, "cooldown-active"))
    return true
  }
  return false
}

/**
 * Finalize a hook execution record: apply matcher, detect slow hooks, and
 * start the cooldown timer when applicable.
 *
 * Cooldowns only activate after a **deny/block** result — when the hook
 * allowed the tool call, the cooldown is not started so the hook will run
 * again on the next invocation. This lets enforcement hooks stay quiet once
 * they've flagged an issue, giving the agent time to fix it without repeated
 * blocks on every tool call.
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
  if (hook.cooldownSeconds && parsed && (isDeny(parsed) || isBlock(parsed))) {
    void markHookCooldown(hook.file, cwd)
  }
  return execution
}

/** Write the final hook response to process.stdout. Exported for strategies. */
export function writeResponse(response: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(response)}\n`)
}

// ─── Response classification ────────────────────────────────────────────────

export function isDeny(resp: Record<string, unknown>): boolean {
  if (resp.decision === "deny" || resp.decision === "block") return true
  if (resp.continue === false) return true
  const hso = resp.hookSpecificOutput as Record<string, unknown> | undefined
  return hso?.permissionDecision === "deny" || hso?.decision === "deny" || hso?.decision === "block"
}

export function isAllowWithReason(resp: Record<string, unknown>): boolean {
  const hso = resp.hookSpecificOutput as Record<string, unknown> | undefined
  return hso?.permissionDecision === "allow" && typeof hso?.permissionDecisionReason === "string"
}

export function extractAllowReason(resp: Record<string, unknown>): string | null {
  const hso = resp.hookSpecificOutput as Record<string, unknown> | undefined
  if (hso?.permissionDecision === "allow" && typeof hso?.permissionDecisionReason === "string") {
    return hso.permissionDecisionReason as string
  }
  return null
}

export function isBlock(resp: Record<string, unknown>): boolean {
  if (resp.decision === "block" || resp.decision === "deny") return true
  if (resp.continue === false) return true
  const hso = resp.hookSpecificOutput as Record<string, unknown> | undefined
  return hso?.decision === "block" || hso?.decision === "deny"
}

export function extractContext(resp: Record<string, unknown>): string | null {
  const hso = resp.hookSpecificOutput as Record<string, unknown> | undefined
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

/** Collect all sync hooks from all groups into a flat ordered list. Exported for unit tests. */
export function flatSyncHooks(groups: HookGroup[]): HookEntry[] {
  const entries: HookEntry[] = []
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (!hook.async) entries.push({ hook, matcher: group.matcher })
    }
  }
  return entries
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
): Promise<{ execution: HookExecution; parsed: Record<string, unknown> | null }> {
  const { hook, matcher } = entry
  // Check abort before skip-condition evaluation to avoid unnecessary work.
  if (signal?.aborted) {
    const now = Date.now()
    return {
      execution: {
        file: hook.file,
        startTime: now,
        endTime: now,
        durationMs: 0,
        configuredTimeoutSec: hook.timeout ?? DEFAULT_TIMEOUT,
        status: "aborted",
        exitCode: null,
        stdoutSnippet: "",
        stderrSnippet: "",
      },
      parsed: null,
    }
  }
  const skipExecs: HookExecution[] = []
  if (await tryRecordSkippedHook(hook, matcher, cwd, skipExecs)) {
    return { execution: skipExecs[0]!, parsed: null }
  }
  log(`   → ${formatHookTarget(hook.file, matcher)}`)
  const { parsed, execution } = await runHook(hook.file, payloadStr, hook.timeout, signal)
  finalizeExecution(execution, matcher, hook, cwd, parsed)
  return { execution, parsed }
}

// ─── Dispatch strategy helpers ───────────────────────────────────────────────

/** Fire async hooks — fire-and-forget in CLI, awaited with timeout in daemon.
 *  When a dispatch-level abort signal is provided, in-flight daemon-context
 *  hooks are killed via the worker pool's abort propagation. */
export async function launchAsyncHooks(
  groups: HookGroup[],
  payloadStr: string,
  daemonContext?: boolean,
  signal?: AbortSignal
): Promise<void> {
  // Flatten all async hooks across groups for concurrent condition evaluation.
  type AsyncEntry = { hook: HookDef; file: string }
  const asyncEntries: AsyncEntry[] = groups.flatMap((group) =>
    group.hooks.filter((h) => h.async).map((h) => ({ hook: h, file: h.file }))
  )
  if (asyncEntries.length === 0) return

  // Evaluate all conditions concurrently instead of sequentially.
  const conditionResults = await Promise.all(
    asyncEntries.map(({ hook }) => evalCondition(hook.condition))
  )

  const promises: Promise<void>[] = []

  // In daemon context, use the worker pool for parallel execution — workers
  // stay alive across requests. In CLI context, use runHook directly —
  // Worker threads would keep the short-lived CLI process alive, causing hangs.
  const pool = daemonContext ? getWorkerPool() : null
  if (pool) await pool.initialize()

  for (let i = 0; i < asyncEntries.length; i++) {
    const { hook } = asyncEntries[i]!
    if (!conditionResults[i]) {
      log(`   ⏭ ${hook.file} [condition false, skipping]`)
      continue
    }
    if (signal?.aborted) {
      log(`   ⏭ ${hook.file} [async, dispatch aborted]`)
      continue
    }
    if (daemonContext && pool) {
      log(`   → ${hook.file} [async, daemon-awaited]`)
      const timeout = hook.timeout ?? DEFAULT_TIMEOUT
      const p = pool
        .runHook(hook.file, payloadStr, timeout, signal)
        .then(() => {})
        .catch((err) => {
          log(`   ⚠ ${hook.file} [async error: ${err}]`)
        })
      promises.push(p)
    } else {
      log(`   → ${hook.file} [async, fire-and-forget]`)
      runHook(hook.file, payloadStr, hook.timeout, signal)
        .then(() => {})
        .catch(() => {})
    }
  }
  if (daemonContext && promises.length > 0) {
    log(`   awaiting ${promises.length} async hook(s) in daemon context`)
    await Promise.all(promises)
  }
}
