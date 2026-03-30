/**
 * Replay trace strategies and ANSI formatting for `swiz dispatch replay`.
 *
 * Extracted from src/commands/dispatch.ts (issue #84).
 */

import { BOLD, DIM, GREEN, RED, RESET, YELLOW } from "../ansi.ts"
import { stderrLog } from "../debug.ts"
import { evalCondition, type FileHookDef, type HookGroup, isInlineHookDef } from "../manifest.ts"
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

function buildTraceEntry(
  hook: { file: string; async?: boolean },
  group: HookGroup,
  execution: { startTime: number; endTime?: number; status: HookStatus; stderrSnippet?: string }
): TraceEntry {
  return {
    file: hook.file,
    ...(group.matcher && { matcher: group.matcher }),
    async: false,
    startTime: execution.startTime,
    endTime: execution.endTime,
    status: execution.status,
    ...(execution.stderrSnippet && { stderr: execution.stderrSnippet }),
  }
}

async function collectEligibleHooks(
  groups: HookGroup[]
): Promise<{ group: HookGroup; hook: FileHookDef }[]> {
  const result: { group: HookGroup; hook: FileHookDef }[] = []
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (isInlineHookDef(hook)) continue // inline hooks run in-process; not replayable as file
      if (hook.async && hook.asyncMode !== "block-until-complete") continue
      if (!(await evalCondition(hook.condition))) {
        log(`   ⏭ ${hook.file} [condition false, skipping]`)
        continue
      }
      result.push({ group, hook })
    }
  }
  return result
}

/** Replay PreToolUse with trace collection: short-circuit on first deny; collect hints. */
export async function replayPreToolUse(
  groups: HookGroup[],
  payloadStr: string
): Promise<TraceEntry[]> {
  const traces: TraceEntry[] = []
  const eligible = await collectEligibleHooks(groups)

  for (const { group, hook } of eligible) {
    const { parsed: resp, execution } = await runHook(hook.file, payloadStr, hook.timeout)
    const entry = buildTraceEntry(hook, group, execution)
    if (resp && isDeny(resp)) {
      entry.status = "deny"
      entry.output = JSON.stringify(resp)
      traces.push(entry)
      return traces
    }
    if (resp && isAllowWithReason(resp)) {
      entry.status = "allow-with-reason"
      entry.reason = extractAllowReason(resp) ?? undefined
    } else if (resp) {
      entry.status = "ok"
    }
    traces.push(entry)
  }
  return traces
}

/** Replay blocking (Stop/PostToolUse): short-circuits on first block. */
export async function replayBlocking(
  groups: HookGroup[],
  payloadStr: string,
  _canonicalEvent?: string
): Promise<TraceEntry[]> {
  const eligible = await collectEligibleHooks(groups)

  const traces: TraceEntry[] = []
  for (const { group, hook } of eligible) {
    const { parsed: resp, execution } = await runHook(hook.file, payloadStr, hook.timeout)
    const entry = buildTraceEntry(hook, group, execution)
    if (resp && isBlock(resp)) {
      entry.status = "block"
      entry.output = JSON.stringify(resp)
      traces.push(entry)
      return traces
    }
    traces.push(entry)
  }
  return traces
}

/** Replay context (SessionStart/UserPromptSubmit) with trace collection: run all hooks. */
export async function replayContext(
  groups: HookGroup[],
  payloadStr: string
): Promise<TraceEntry[]> {
  const eligible = await collectEligibleHooks(groups)

  return Promise.all(
    eligible.map(async ({ group, hook }) => {
      const { parsed: resp, execution } = await runHook(hook.file, payloadStr, hook.timeout)
      const entry = buildTraceEntry(hook, group, execution)
      if (!resp) return entry
      const ctx = extractContext(resp)
      if (ctx) {
        entry.status = "allow-with-reason"
        entry.reason = ctx.slice(0, 200)
      }
      return entry
    })
  )
}

// ─── Trace formatting helpers ────────────────────────────────────────────────

function formatTraceStatus(status: HookStatus): string {
  switch (status) {
    case "deny":
      return `${RED}✗ DENY${RESET}`
    case "block":
      return `${RED}✗ BLOCK${RESET}`
    case "allow-with-reason":
      return `${YELLOW}~ hint${RESET}`
    case "no-output":
      return `${DIM}– no output${RESET}`
    default:
      return `${GREEN}✓ ${status}${RESET}`
  }
}

function extractBlockReason(output: string): string | null {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>
    const hso = parsed.hookSpecificOutput as Record<string, unknown> | undefined
    return (
      (parsed.reason as string | undefined) ??
      (parsed.message as string | undefined) ??
      (hso?.permissionDecisionReason as string | undefined) ??
      (hso?.additionalContext as string | undefined) ??
      null
    )
  } catch {
    return null
  }
}

function logTraceReason(t: TraceEntry, label: string): void {
  if ((t.status === "block" || t.status === "deny") && t.output) {
    const reason = extractBlockReason(t.output)
    if (reason) {
      const preview = reason.trim().split("\n").slice(0, 3).join("\n     ")
      stderrLog(label, `     ${DIM}${preview}${RESET}`)
    } else {
      stderrLog(label, `     ${DIM}${t.output.slice(0, 200)}${RESET}`)
    }
  }
  if (t.reason && t.status === "allow-with-reason") {
    const preview = t.reason.trim().split("\n").slice(0, 2).join("\n     ")
    stderrLog(label, `     ${DIM}${preview}${RESET}`)
  }
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

  for (let i = 0; i < traces.length; i++) {
    const t = traces[i]!
    const ms = t.endTime !== undefined ? `${t.endTime - t.startTime}ms` : "?"
    const matcherStr = t.matcher ? ` ${DIM}[${t.matcher}]${RESET}` : ""
    const fileStr = `${BOLD}${t.file}${RESET}${matcherStr}`
    const statusStr = formatTraceStatus(t.status)

    stderrLog(REPLAY_PER_HOOK, `  ${i + 1}. ${fileStr}  ${DIM}${ms}${RESET}  ${statusStr}`)
    logTraceReason(t, REPLAY_REASON)
  }

  const blocked = traces.find((t) => t.status === "block" || t.status === "deny")
  stderrLog(REPLAY_RESULT, `\n${BOLD}${hr}${RESET}`)
  if (blocked) {
    stderrLog(
      REPLAY_RESULT,
      `${BOLD}Result:${RESET} ${RED}${blocked.status.toUpperCase()} by ${blocked.file}${RESET}`
    )
    // Forward the hook's block/deny JSON to stdout so Claude Code receives it.
    // Without this, the dispatch process exits with empty stdout and the block is silently lost.
    if (blocked.output) {
      process.stdout.write(`${blocked.output}\n`)
    }
  } else {
    stderrLog(REPLAY_RESULT, `${BOLD}Result:${RESET} ${GREEN}all passed${RESET}`)
  }
  stderrLog(REPLAY_RESULT, `${BOLD}${hr}${RESET}\n`)
}
