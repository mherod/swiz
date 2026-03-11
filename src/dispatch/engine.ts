/**
 * Hook execution engine — runs individual hooks, classifies responses,
 * and implements the three dispatch strategies (preToolUse, blocking, context).
 *
 * Extracted from src/commands/dispatch.ts (issue #84).
 */

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
import { extractCwd, isWithinCooldown, markHookCooldown } from "./filters.ts"

// ─── Module-level constants ─────────────────────────────────────────────────

const SWIZ_ROOT = join(import.meta.dir, "..", "..")
const HOOKS_DIR = join(SWIZ_ROOT, "hooks")
const LOG_PATH = swizDispatchLogPath()
export const DEFAULT_TIMEOUT = 10 // seconds

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

export function log(msg: string): void {
  appendFile(LOG_PATH, `${msg}\n`).catch(() => {})
  debugLog(msg)
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

function logSlowHookSummary(executions: HookExecution[]): void {
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
    // Stdout may contain non-JSON prefix text (e.g. SDK log lines like
    // "Loaded cached credentials.") before the actual JSON object.
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
  if (toolName === token) return true
  if (isShellTool(toolName) && isShellTool(token)) return true
  if (isEditTool(toolName) && isEditTool(token)) return true
  if (isWriteTool(toolName) && isWriteTool(token)) return true
  if (isNotebookTool(toolName) && isNotebookTool(token)) return true
  // Task tools: specific families first, then broad "Task" family
  if (isTaskCreateTool(toolName) && isTaskCreateTool(token)) return true
  if (isTaskUpdateTool(toolName) && isTaskUpdateTool(token)) return true
  if (isTaskListTool(toolName) && isTaskListTool(token)) return true
  if (isTaskGetTool(toolName) && isTaskGetTool(token)) return true
  // Broad "Task" family: only when token or toolName is the umbrella "Task"
  if (token === "Task" && isTaskTool(toolName)) return true
  if (toolName === "Task" && isTaskTool(token)) return true
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

export async function runHook(
  file: string,
  payloadStr: string,
  timeoutSec?: number
): Promise<HookRunResult> {
  const cmd = file.endsWith(".ts") ? ["bun", join(HOOKS_DIR, file)] : [join(HOOKS_DIR, file)]
  const startTime = Date.now()
  const configuredTimeoutSec = timeoutSec ?? DEFAULT_TIMEOUT

  const proc = Bun.spawn(cmd, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

  proc.stdin.write(payloadStr)
  proc.stdin.end()

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    log(`   ⏱ TIMEOUT (${configuredTimeoutSec}s) — killing ${file}`)
    proc.kill()
  }, configuredTimeoutSec * 1000)

  const [output, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  clearTimeout(timer)

  const endTime = Date.now()
  const exitCode = proc.exitCode
  const trimmed = output.trim()
  const stderrTrimmed = stderr.trim()

  if (stderrTrimmed) log(`   stderr: ${stderrTrimmed.slice(0, 500)}`)
  if (exitCode !== 0) log(`   exit=${exitCode}`)
  if (trimmed) log(`   stdout: ${trimmed.slice(0, 500)}`)

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
  if (!evalCondition(hook.condition)) {
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

function finalizeExecution(
  execution: HookExecution,
  matcher: string | undefined,
  hook: HookDef,
  cwd: string
): HookExecution {
  if (matcher) execution.matcher = matcher
  if (execution.status === "ok" && logSlowHook(execution.file, execution.durationMs)) {
    execution.status = "slow"
  }
  if (hook.cooldownSeconds) markHookCooldown(hook.file, cwd)
  return execution
}

function writeResponse(response: Record<string, unknown>): void {
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
 */
async function runEntry(
  entry: HookEntry,
  payloadStr: string,
  cwd: string
): Promise<{ execution: HookExecution; parsed: Record<string, unknown> | null }> {
  const { hook, matcher } = entry
  const skipExecs: HookExecution[] = []
  if (await tryRecordSkippedHook(hook, matcher, cwd, skipExecs)) {
    return { execution: skipExecs[0]!, parsed: null }
  }
  log(`   → ${formatHookTarget(hook.file, matcher)}`)
  const { parsed, execution } = await runHook(hook.file, payloadStr, hook.timeout)
  finalizeExecution(execution, matcher, hook, cwd)
  return { execution, parsed }
}

// ─── Dispatch strategies ────────────────────────────────────────────────────

/** Fire async hooks — fire-and-forget in CLI, awaited with timeout in daemon. */
export async function launchAsyncHooks(
  groups: HookGroup[],
  payloadStr: string,
  daemonContext?: boolean
): Promise<void> {
  const promises: Promise<void>[] = []
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.async) {
        if (!evalCondition(hook.condition)) {
          log(`   ⏭ ${hook.file} [condition false, skipping]`)
          continue
        }
        if (daemonContext) {
          log(`   → ${hook.file} [async, daemon-awaited]`)
          const timeout = hook.timeout ?? DEFAULT_TIMEOUT
          const p = runHook(hook.file, payloadStr, timeout)
            .then(() => {})
            .catch((err) => {
              log(`   ⚠ ${hook.file} [async error: ${err}]`)
            })
          promises.push(p)
        } else {
          log(`   → ${hook.file} [async, fire-and-forget]`)
          runHook(hook.file, payloadStr, hook.timeout)
            .then(() => {})
            .catch(() => {})
        }
      }
    }
  }
  if (daemonContext && promises.length > 0) {
    log(`   awaiting ${promises.length} async hook(s) in daemon context`)
    await Promise.all(promises)
  }
}

/** PreToolUse: short-circuit on first deny; collect and merge allow-with-reason hints. */
export async function runPreToolUse(
  groups: HookGroup[],
  payloadStr: string,
  daemonContext?: boolean
): Promise<Record<string, unknown>> {
  await launchAsyncHooks(groups, payloadStr, daemonContext)
  const cwd = extractCwd(payloadStr)
  const hints: string[] = []
  const contexts: string[] = []
  const finalResponse: Record<string, unknown> = {}
  const executions: HookExecution[] = []

  // Fan out all sync hooks concurrently; scan results in declaration order.
  const entries = flatSyncHooks(groups)
  const results = await Promise.all(entries.map((e) => runEntry(e, payloadStr, cwd)))

  for (const { execution, parsed: resp } of results) {
    if (execution.status === "skipped") {
      executions.push(execution)
      continue
    }
    if (resp && isDeny(resp)) {
      log(`   ✗ DENY from ${execution.file}`)
      execution.status = "deny"
      executions.push(execution)
      Object.assign(finalResponse, resp)
      break
    }
    if (resp) {
      const hso = resp.hookSpecificOutput as Record<string, unknown> | undefined
      const reason = extractAllowReason(resp)
      const context = extractContext(resp)
      if (hso?.permissionDecision === "allow" && (reason || context)) {
        execution.status = "allow-with-reason"
        executions.push(execution)
        if (reason) hints.push(reason)
        if (context) contexts.push(context)
        const preview = reason ?? context ?? ""
        log(`   ~ ${execution.file} (hint: ${preview.slice(0, 100)})`)
        continue
      }
    }
    log(`   ✓ ${execution.file} (${resp ? "allow" : "no output"})`)
    executions.push(execution)
  }

  if (!isDeny(finalResponse)) {
    if (hints.length > 0 || contexts.length > 0) {
      log(
        `   result: passed with ${hints.length} hint(s)` +
          (contexts.length > 0 ? ` and ${contexts.length} context(s)` : "")
      )
      Object.assign(finalResponse, {
        ...(contexts.length > 0 ? { systemMessage: contexts.join("\n\n") } : {}),
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          ...(hints.length > 0 ? { permissionDecisionReason: hints.join("\n\n") } : {}),
          ...(contexts.length > 0 ? { additionalContext: contexts.join("\n\n") } : {}),
        },
      })
    } else {
      log(`   result: all passed`)
    }
  }
  logSlowHookSummary(executions)
  if (executions.length > 0) Object.assign(finalResponse, { hookExecutions: executions })

  writeResponse(finalResponse)
  return finalResponse
}

/** Stop / PostToolUse: forward first block; stop runs all hooks, postToolUse short-circuits. */
export async function runBlocking(
  groups: HookGroup[],
  payloadStr: string,
  canonicalEvent?: string,
  daemonContext?: boolean
): Promise<Record<string, unknown>> {
  await launchAsyncHooks(groups, payloadStr, daemonContext)
  const cwd = extractCwd(payloadStr)
  const runAllHooks = canonicalEvent === "stop"
  const finalResponse: Record<string, unknown> = {}
  const executions: HookExecution[] = []

  // Fan out all sync hooks concurrently; scan results in declaration order.
  const entries = flatSyncHooks(groups)
  const results = await Promise.all(entries.map((e) => runEntry(e, payloadStr, cwd)))

  for (const { execution, parsed: resp } of results) {
    if (execution.status === "skipped") {
      executions.push(execution)
      continue
    }
    if (resp && isBlock(resp)) {
      log(`   ✗ BLOCK from ${execution.file}`)
      execution.status = "block"
      executions.push(execution)
      // Keep the first block response exactly as produced.
      if (!isBlock(finalResponse)) Object.assign(finalResponse, resp)
      if (!runAllHooks) break
      continue
    }
    log(`   ✓ ${execution.file} (${resp ? "ok" : "no output"})`)
    executions.push(execution)
  }

  if (!isBlock(finalResponse)) {
    log(`   result: all passed`)
  }
  logSlowHookSummary(executions)
  if (executions.length > 0) Object.assign(finalResponse, { hookExecutions: executions })

  writeResponse(finalResponse)
  return finalResponse
}

/** SessionStart / UserPromptSubmit: run all hooks, merge additionalContext. */
export async function runContext(
  groups: HookGroup[],
  payloadStr: string,
  eventName: string,
  daemonContext?: boolean
): Promise<Record<string, unknown>> {
  await launchAsyncHooks(groups, payloadStr, daemonContext)
  const cwd = extractCwd(payloadStr)
  const contexts: string[] = []
  const executions: HookExecution[] = []

  // All context hooks are independent — fan out fully, merge results in order.
  const entries = flatSyncHooks(groups)
  const results = await Promise.all(entries.map((e) => runEntry(e, payloadStr, cwd)))

  for (const { execution, parsed: resp } of results) {
    if (execution.status === "skipped") {
      executions.push(execution)
      continue
    }
    if (!resp) {
      log(`   ✓ ${execution.file} (no output)`)
      executions.push(execution)
      continue
    }
    const ctx = extractContext(resp)
    if (ctx) {
      execution.status = "allow-with-reason"
      contexts.push(ctx)
      log(`   ✓ ${execution.file} (context: ${ctx.slice(0, 100)})`)
    } else {
      log(`   ✓ ${execution.file} (no context extracted)`)
    }
    executions.push(execution)
  }

  const finalResponse: Record<string, unknown> = {}

  if (contexts.length === 0) {
    log(`   result: no contexts to merge`)
  } else {
    log(`   result: merged ${contexts.length} context(s), hookEventName=${eventName}`)
    Object.assign(finalResponse, {
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: contexts.join("\n\n"),
      },
    })
  }
  logSlowHookSummary(executions)
  if (executions.length > 0) Object.assign(finalResponse, { hookExecutions: executions })

  writeResponse(finalResponse)
  return finalResponse
}
