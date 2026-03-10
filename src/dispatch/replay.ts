/**
 * Replay trace strategies and ANSI formatting for `swiz dispatch replay`.
 *
 * Extracted from src/commands/dispatch.ts (issue #84).
 */

import { BOLD, DIM, GREEN, RED, RESET, YELLOW } from "../ansi.ts"
import { stderrLog } from "../debug.ts"
import { evalCondition, type HookGroup } from "../manifest.ts"
import {
  extractAllowReason,
  extractContext,
  type HookStatus,
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
  status: HookStatus
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
      const { parsed: resp, execution } = await runHook(hook.file, payloadStr, hook.timeout)
      const entry: TraceEntry = {
        file: hook.file,
        ...(group.matcher && { matcher: group.matcher }),
        async: false,
        startTime: execution.startTime,
        endTime: execution.endTime,
        status: execution.status,
        ...(execution.stderrSnippet && { stderr: execution.stderrSnippet }),
      }
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
      if (resp) entry.status = "ok"
      traces.push(entry)
    }
  }
  return traces
}

/** Replay blocking (Stop/PostToolUse): stop runs all hooks; postToolUse short-circuits on first block. */
export async function replayBlocking(
  groups: HookGroup[],
  payloadStr: string,
  canonicalEvent?: string
): Promise<TraceEntry[]> {
  const traces: TraceEntry[] = []
  const runAllHooks = canonicalEvent === "stop"

  // For stop events (runAllHooks = true), parallelize hook execution.
  // For postToolUse events, keep sequential with short-circuit on block.
  if (runAllHooks) {
    // Collect eligible hooks across all groups while preserving order.
    interface QueuedHook {
      group: HookGroup
      hook: (typeof groups)[0]["hooks"][0]
      index: number
    }
    const queuedHooks: QueuedHook[] = []
    let index = 0
    for (const group of groups) {
      for (const hook of group.hooks) {
        if (hook.async) continue
        if (!evalCondition(hook.condition)) {
          log(`   ⏭ ${hook.file} [condition false, skipping]`)
          continue
        }
        queuedHooks.push({ group, hook, index })
        index++
      }
    }

    // Run all eligible hooks in parallel.
    const results = await Promise.all(
      queuedHooks.map(async ({ group, hook }) => {
        const { parsed: resp, execution } = await runHook(hook.file, payloadStr, hook.timeout)
        const entry: TraceEntry = {
          file: hook.file,
          ...(group.matcher && { matcher: group.matcher }),
          async: false,
          startTime: execution.startTime,
          endTime: execution.endTime,
          status: execution.status,
          ...(execution.stderrSnippet && { stderr: execution.stderrSnippet }),
        }
        if (resp && isBlock(resp)) {
          entry.status = "block"
          entry.output = JSON.stringify(resp)
        }
        return entry
      })
    )

    traces.push(...results)
    return traces
  }

  // Sequential execution with short-circuit for postToolUse events.
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.async) continue
      if (!evalCondition(hook.condition)) {
        log(`   ⏭ ${hook.file} [condition false, skipping]`)
        continue
      }
      const { parsed: resp, execution } = await runHook(hook.file, payloadStr, hook.timeout)
      const entry: TraceEntry = {
        file: hook.file,
        ...(group.matcher && { matcher: group.matcher }),
        async: false,
        startTime: execution.startTime,
        endTime: execution.endTime,
        status: execution.status,
        ...(execution.stderrSnippet && { stderr: execution.stderrSnippet }),
      }
      if (resp && isBlock(resp)) {
        entry.status = "block"
        entry.output = JSON.stringify(resp)
        traces.push(entry)
        return traces // Short-circuit on block for non-stop events
      }
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

  // Collect eligible hooks across all groups while preserving order.
  interface QueuedHook {
    group: HookGroup
    hook: (typeof groups)[0]["hooks"][0]
  }
  const queuedHooks: QueuedHook[] = []
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.async) continue
      if (!evalCondition(hook.condition)) {
        log(`   ⏭ ${hook.file} [condition false, skipping]`)
        continue
      }
      queuedHooks.push({ group, hook })
    }
  }

  // Run all eligible hooks in parallel.
  const results = await Promise.all(
    queuedHooks.map(async ({ group, hook }) => {
      const { parsed: resp, execution } = await runHook(hook.file, payloadStr, hook.timeout)
      const entry: TraceEntry = {
        file: hook.file,
        ...(group.matcher && { matcher: group.matcher }),
        async: false,
        startTime: execution.startTime,
        endTime: execution.endTime,
        status: execution.status,
        ...(execution.stderrSnippet && { stderr: execution.stderrSnippet }),
      }
      if (!resp) {
        return entry
      }
      const ctx = extractContext(resp)
      if (ctx) {
        entry.status = "allow-with-reason"
        entry.reason = ctx.slice(0, 200)
      }
      return entry
    })
  )

  traces.push(...results)
  return traces
}

// ─── Trace formatting ───────────────────────────────────────────────────────

export function formatTrace(
  event: string,
  strategy: DispatchStrategy,
  matchedCount: number,
  traces: TraceEntry[],
  jsonMode: boolean
): void {
  if (jsonMode) {
    const blocked = traces.find((t) => t.status === "block" || t.status === "deny")
    process.stdout.write(
      `${JSON.stringify({
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
      })}\n`
    )
    return
  }

  const REPLAY_HEADER = "replay trace header — stderr keeps trace output separate from hook stdout"
  const REPLAY_PER_HOOK =
    "replay trace per-hook result — stderr keeps trace output separate from hook stdout"
  const REPLAY_REASON =
    "replay trace block/deny reason preview — stderr keeps trace output separate from hook stdout"
  const REPLAY_RESULT =
    "replay trace result summary — stderr keeps trace output separate from hook stdout"

  const hr = "━".repeat(50)
  stderrLog(REPLAY_HEADER, `\n${BOLD}${hr}${RESET}`)
  stderrLog(REPLAY_HEADER, `${BOLD}swiz dispatch replay:${RESET} ${event}`)
  stderrLog(REPLAY_HEADER, `${DIM}strategy: ${strategy} | ${matchedCount} group(s) matched${RESET}`)
  stderrLog(REPLAY_HEADER, `${BOLD}${hr}${RESET}\n`)

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

    stderrLog(REPLAY_PER_HOOK, `  ${i + 1}. ${fileStr}  ${DIM}${ms}${RESET}  ${statusStr}`)
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
          stderrLog(REPLAY_REASON, `     ${DIM}${preview}${RESET}`)
        }
      } catch {
        stderrLog(REPLAY_REASON, `     ${DIM}${t.output.slice(0, 200)}${RESET}`)
      }
    }
    if (t.reason && t.status === "allow-with-reason") {
      const preview = t.reason.trim().split("\n").slice(0, 2).join("\n     ")
      stderrLog(REPLAY_REASON, `     ${DIM}${preview}${RESET}`)
    }
  })

  const blocked = traces.find((t) => t.status === "block" || t.status === "deny")
  stderrLog(REPLAY_RESULT, `\n${BOLD}${hr}${RESET}`)
  if (blocked) {
    stderrLog(
      REPLAY_RESULT,
      `${BOLD}Result:${RESET} ${RED}${blocked.status.toUpperCase()} by ${blocked.file}${RESET}`
    )
  } else {
    stderrLog(REPLAY_RESULT, `${BOLD}Result:${RESET} ${GREEN}all passed${RESET}`)
  }
  stderrLog(REPLAY_RESULT, `${BOLD}${hr}${RESET}\n`)
}
