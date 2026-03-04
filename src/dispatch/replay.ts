/**
 * Replay trace strategies and ANSI formatting for `swiz dispatch replay`.
 *
 * Extracted from src/commands/dispatch.ts (issue #84).
 */

import { evalCondition, type HookGroup } from "../manifest.ts"
import {
  extractAllowReason,
  extractContext,
  isAllowWithReason,
  isBlock,
  isDeny,
  log,
  runHook,
} from "./engine.ts"
import type { DispatchStrategy } from "./types.ts"

// ─── Trace types ────────────────────────────────────────────────────────────

export interface TraceEntry {
  file: string
  matcher?: string
  async: boolean
  startTime: number
  endTime?: number
  status: "pending" | "allow" | "allow-with-reason" | "deny" | "block" | "ok" | "no-output"
  reason?: string
  output?: string
  stderr?: string
}

// ─── Replay strategies ──────────────────────────────────────────────────────

/** Replay PreToolUse with trace collection: short-circuit on first deny; collect hints. */
export async function replayPreToolUse(
  groups: HookGroup[],
  payloadStr: string
): Promise<TraceEntry[]> {
  const traces: TraceEntry[] = []
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.async) continue
      if (!evalCondition(hook.condition)) {
        log(`   ⏭ ${hook.file} [condition false, skipping]`)
        continue
      }
      const startTime = Date.now()
      const entry: TraceEntry = {
        file: hook.file,
        ...(group.matcher && { matcher: group.matcher }),
        async: false,
        startTime,
        status: "pending",
      }
      const resp = await runHook(hook.file, payloadStr, hook.timeout)
      entry.endTime = Date.now()
      if (resp && isDeny(resp)) {
        entry.status = "deny"
        entry.output = JSON.stringify(resp)
        traces.push(entry)
        return traces // Short-circuit on deny
      }
      if (resp && isAllowWithReason(resp)) {
        entry.status = "allow-with-reason"
        entry.reason = extractAllowReason(resp) ?? undefined
        traces.push(entry)
        continue
      }
      entry.status = resp ? "allow" : "no-output"
      traces.push(entry)
    }
  }
  return traces
}

/** Replay blocking (Stop/PostToolUse) with trace collection: short-circuit on first block. */
export async function replayBlocking(
  groups: HookGroup[],
  payloadStr: string
): Promise<TraceEntry[]> {
  const traces: TraceEntry[] = []
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.async) continue
      if (!evalCondition(hook.condition)) {
        log(`   ⏭ ${hook.file} [condition false, skipping]`)
        continue
      }
      const startTime = Date.now()
      const entry: TraceEntry = {
        file: hook.file,
        ...(group.matcher && { matcher: group.matcher }),
        async: false,
        startTime,
        status: "pending",
      }
      const resp = await runHook(hook.file, payloadStr, hook.timeout)
      entry.endTime = Date.now()
      if (resp && isBlock(resp)) {
        entry.status = "block"
        entry.output = JSON.stringify(resp)
        traces.push(entry)
        return traces // Short-circuit on block
      }
      entry.status = resp ? "ok" : "no-output"
      traces.push(entry)
    }
  }
  return traces
}

/** Replay context (SessionStart/UserPromptSubmit) with trace collection: run all hooks. */
export async function replayContext(
  groups: HookGroup[],
  payloadStr: string
): Promise<TraceEntry[]> {
  const traces: TraceEntry[] = []
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.async) continue
      if (!evalCondition(hook.condition)) {
        log(`   ⏭ ${hook.file} [condition false, skipping]`)
        continue
      }
      const startTime = Date.now()
      const entry: TraceEntry = {
        file: hook.file,
        ...(group.matcher && { matcher: group.matcher }),
        async: false,
        startTime,
        status: "pending",
      }
      const resp = await runHook(hook.file, payloadStr, hook.timeout)
      entry.endTime = Date.now()
      if (!resp) {
        entry.status = "no-output"
        traces.push(entry)
        continue
      }
      const ctx = extractContext(resp)
      entry.status = ctx ? "allow-with-reason" : "ok"
      if (ctx) entry.reason = ctx.slice(0, 200)
      traces.push(entry)
    }
  }
  return traces
}

// ─── Trace formatting ───────────────────────────────────────────────────────

const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const YELLOW = "\x1b[33m"
const RESET = "\x1b[0m"

export function formatTrace(
  event: string,
  strategy: DispatchStrategy,
  matchedCount: number,
  traces: TraceEntry[],
  jsonMode: boolean
): void {
  if (jsonMode) {
    const blocked = traces.find((t) => t.status === "block" || t.status === "deny")
    console.log(
      JSON.stringify({
        event,
        strategy,
        matched_groups: matchedCount,
        hooks: traces.map((t) => ({
          file: t.file,
          ...(t.matcher && { matcher: t.matcher }),
          async: t.async,
          duration_ms: t.endTime !== undefined ? t.endTime - t.startTime : null,
          status: t.status,
          ...(t.reason && { reason: t.reason }),
        })),
        result: blocked
          ? { blocked: true, by: blocked.file, status: blocked.status }
          : { blocked: false },
      })
    )
    return
  }

  const hr = "━".repeat(50)
  console.error(`\n${BOLD}${hr}${RESET}`)
  console.error(`${BOLD}swiz dispatch replay:${RESET} ${event}`)
  console.error(`${DIM}strategy: ${strategy} | ${matchedCount} group(s) matched${RESET}`)
  console.error(`${BOLD}${hr}${RESET}\n`)

  traces.forEach((t, i) => {
    const ms = t.endTime !== undefined ? `${t.endTime - t.startTime}ms` : "?"
    const matcherStr = t.matcher ? ` ${DIM}[${t.matcher}]${RESET}` : ""
    const fileStr = `${BOLD}${t.file}${RESET}${matcherStr}`

    let statusStr: string
    switch (t.status) {
      case "deny":
        statusStr = `${RED}✗ DENY${RESET}`
        break
      case "block":
        statusStr = `${RED}✗ BLOCK${RESET}`
        break
      case "allow-with-reason":
        statusStr = `${YELLOW}~ hint${RESET}`
        break
      case "no-output":
        statusStr = `${DIM}– no output${RESET}`
        break
      default:
        statusStr = `${GREEN}✓ ${t.status}${RESET}`
    }

    console.error(`  ${i + 1}. ${fileStr}  ${DIM}${ms}${RESET}  ${statusStr}`)
    if ((t.status === "block" || t.status === "deny") && t.output) {
      try {
        const parsed = JSON.parse(t.output) as Record<string, unknown>
        const hso = parsed.hookSpecificOutput as Record<string, unknown> | undefined
        const reason =
          (parsed.reason as string | undefined) ??
          (parsed.message as string | undefined) ??
          (hso?.permissionDecisionReason as string | undefined) ??
          (hso?.additionalContext as string | undefined)
        if (reason) {
          const preview = reason.trim().split("\n").slice(0, 3).join("\n     ")
          console.error(`     ${DIM}${preview}${RESET}`)
        }
      } catch {
        console.error(`     ${DIM}${t.output.slice(0, 200)}${RESET}`)
      }
    }
    if (t.reason && t.status === "allow-with-reason") {
      const preview = t.reason.trim().split("\n").slice(0, 2).join("\n     ")
      console.error(`     ${DIM}${preview}${RESET}`)
    }
  })

  const blocked = traces.find((t) => t.status === "block" || t.status === "deny")
  console.error(`\n${BOLD}${hr}${RESET}`)
  if (blocked) {
    console.error(
      `${BOLD}Result:${RESET} ${RED}${blocked.status.toUpperCase()} by ${blocked.file}${RESET}`
    )
  } else {
    console.error(`${BOLD}Result:${RESET} ${GREEN}all passed${RESET}`)
  }
  console.error(`${BOLD}${hr}${RESET}\n`)
}
