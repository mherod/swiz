/**
 * Hook execution engine — runs individual hooks, classifies responses,
 * and implements the three dispatch strategies (preToolUse, blocking, context).
 *
 * Extracted from src/commands/dispatch.ts (issue #84).
 */

import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { debugLog } from "../debug.ts"
import { evalCondition, type HookGroup } from "../manifest.ts"
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
const LOG_PATH = "/tmp/swiz-dispatch.log"
const DEFAULT_TIMEOUT = 10 // seconds

// ─── Debug logger ───────────────────────────────────────────────────────────

export function log(msg: string): void {
  try {
    appendFileSync(LOG_PATH, `${msg}\n`)
    debugLog(msg)
  } catch {
    // Never let logging break dispatch
  }
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

export async function runHook(
  file: string,
  payloadStr: string,
  timeoutSec?: number
): Promise<Record<string, unknown> | null> {
  const cmd = file.endsWith(".ts") ? ["bun", join(HOOKS_DIR, file)] : [join(HOOKS_DIR, file)]

  const proc = Bun.spawn(cmd, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

  proc.stdin.write(payloadStr)
  proc.stdin.end()

  const deadline = (timeoutSec ?? DEFAULT_TIMEOUT) * 1000
  const timer = setTimeout(() => {
    log(`   ⏱ TIMEOUT (${timeoutSec ?? DEFAULT_TIMEOUT}s) — killing ${file}`)
    proc.kill()
  }, deadline)

  const [output, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  clearTimeout(timer)

  const exitCode = proc.exitCode
  const trimmed = output.trim()

  if (stderr.trim()) log(`   stderr: ${stderr.trim().slice(0, 500)}`)
  if (exitCode !== 0) log(`   exit=${exitCode}`)
  if (trimmed) log(`   stdout: ${trimmed.slice(0, 500)}`)

  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    log(`   ⚠ invalid JSON: ${trimmed.slice(0, 200)}`)
    return null
  }
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

// ─── Dispatch strategies ────────────────────────────────────────────────────

/** Fire all async hooks immediately without awaiting. */
export function launchAsyncHooks(groups: HookGroup[], payloadStr: string): void {
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.async) {
        if (!evalCondition(hook.condition)) {
          log(`   ⏭ ${hook.file} [condition false, skipping]`)
          continue
        }
        log(`   → ${hook.file} [async, fire-and-forget]`)
        runHook(hook.file, payloadStr, hook.timeout).catch(() => {})
      }
    }
  }
}

/** PreToolUse: short-circuit on first deny; collect and merge allow-with-reason hints. */
export async function runPreToolUse(groups: HookGroup[], payloadStr: string): Promise<void> {
  launchAsyncHooks(groups, payloadStr)
  const cwd = extractCwd(payloadStr)
  const hints: string[] = []
  const finalResponse = {}

  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.async) continue
      if (!evalCondition(hook.condition)) {
        log(`   ⏭ ${hook.file} [condition false, skipping]`)
        continue
      }
      if (hook.cooldownSeconds && isWithinCooldown(hook.file, hook.cooldownSeconds, cwd)) {
        log(`   ⏭ ${hook.file} [cooldown active, skipping]`)
        continue
      }
      log(`   → ${hook.file}${group.matcher ? ` [${group.matcher}]` : ""}`)
      const resp = await runHook(hook.file, payloadStr, hook.timeout)
      if (hook.cooldownSeconds) markHookCooldown(hook.file, cwd)
      if (resp && isDeny(resp)) {
        log(`   ✗ DENY from ${hook.file}`)
        Object.assign(finalResponse, resp)
        break
      }
      if (resp && isAllowWithReason(resp)) {
        const reason = extractAllowReason(resp)
        if (reason) {
          hints.push(reason)
          log(`   ~ ${hook.file} (hint: ${reason.slice(0, 100)})`)
          continue
        }
      }
      log(`   ✓ ${hook.file} (${resp ? "allow" : "no output"})`)
    }
    if (isDeny(finalResponse)) break
  }

  if (!isDeny(finalResponse)) {
    if (hints.length > 0) {
      log(`   result: passed with ${hints.length} hint(s)`)
      Object.assign(finalResponse, {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: hints.join("\n\n"),
        },
      })
    } else {
      log(`   result: all passed`)
    }
  }

  process.stdout.write(`${JSON.stringify(finalResponse)}\n`)
}

/** Stop / PostToolUse: forward first block; stop runs all hooks, postToolUse short-circuits. */
export async function runBlocking(
  groups: HookGroup[],
  payloadStr: string,
  canonicalEvent?: string
): Promise<void> {
  launchAsyncHooks(groups, payloadStr)
  const cwd = extractCwd(payloadStr)
  const runAllHooks = canonicalEvent === "stop"
  const finalResponse: Record<string, unknown> = {}

  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.async) continue
      if (!evalCondition(hook.condition)) {
        log(`   ⏭ ${hook.file} [condition false, skipping]`)
        continue
      }
      if (hook.cooldownSeconds && isWithinCooldown(hook.file, hook.cooldownSeconds, cwd)) {
        log(`   ⏭ ${hook.file} [cooldown active, skipping]`)
        continue
      }
      log(`   → ${hook.file}${group.matcher ? ` [${group.matcher}]` : ""}`)
      const resp = await runHook(hook.file, payloadStr, hook.timeout)
      if (hook.cooldownSeconds) markHookCooldown(hook.file, cwd)
      if (resp && isBlock(resp)) {
        log(`   ✗ BLOCK from ${hook.file}`)
        // Keep the first block response exactly as produced.
        if (!isBlock(finalResponse)) Object.assign(finalResponse, resp)
        if (!runAllHooks) break
        continue
      }
      log(`   ✓ ${hook.file} (${resp ? "ok" : "no output"})`)
    }
    if (!runAllHooks && isBlock(finalResponse)) break
  }

  if (!isBlock(finalResponse)) {
    log(`   result: all passed`)
  }

  process.stdout.write(`${JSON.stringify(finalResponse)}\n`)
}

/** SessionStart / UserPromptSubmit: run all hooks, merge additionalContext. */
export async function runContext(
  groups: HookGroup[],
  payloadStr: string,
  eventName: string
): Promise<void> {
  launchAsyncHooks(groups, payloadStr)
  const cwd = extractCwd(payloadStr)
  const contexts: string[] = []
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.async) continue
      if (!evalCondition(hook.condition)) {
        log(`   ⏭ ${hook.file} [condition false, skipping]`)
        continue
      }
      if (hook.cooldownSeconds && isWithinCooldown(hook.file, hook.cooldownSeconds, cwd)) {
        log(`   ⏭ ${hook.file} [cooldown active, skipping]`)
        continue
      }
      log(`   → ${hook.file}${group.matcher ? ` [${group.matcher}]` : ""}`)
      const resp = await runHook(hook.file, payloadStr, hook.timeout)
      if (hook.cooldownSeconds) markHookCooldown(hook.file, cwd)
      if (!resp) {
        log(`   ✓ ${hook.file} (no output)`)
        continue
      }
      const ctx = extractContext(resp)
      if (ctx) {
        contexts.push(ctx)
        log(`   ✓ ${hook.file} (context: ${ctx.slice(0, 100)})`)
      } else {
        log(`   ✓ ${hook.file} (no context extracted)`)
      }
    }
  }

  const finalResponse = {}

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

  process.stdout.write(`${JSON.stringify(finalResponse)}\n`)
}
