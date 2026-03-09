/**
 * Dispatch command — CLI entry point for `swiz dispatch <event>`.
 *
 * The heavy lifting (filters, engine, replay) lives in src/dispatch/.
 * This file handles CLI parsing, plugin loading, transcript enrichment,
 * and re-exports all public symbols for backward compatibility.
 */

import { merge, orderBy } from "lodash-es"
import {
  applyHookSettingFilters,
  countHooks,
  DISPATCH_ROUTES,
  formatTrace,
  groupMatches,
  log,
  logHeader,
  replayBlocking,
  replayContext,
  replayPreToolUse,
  runBlocking,
  runContext,
  runPreToolUse,
} from "../dispatch/index.ts"
import { tryReplayPendingMutations } from "../issue-store.ts"
import type { HookGroup } from "../manifest.ts"
import { manifest } from "../manifest.ts"
import { loadAllPlugins } from "../plugins.ts"
import { readProjectSettings, resolveProjectHooks } from "../settings.ts"
import { computeTranscriptSummary } from "../transcript-summary.ts"
import type { Command } from "../types.ts"

const STDIN_PAYLOAD_TIMEOUT_MS = 2_000
const TOOL_NAME_OPTIONAL_EVENTS = new Set([
  "sessionStart",
  "subagentStart",
  "subagentStop",
  "userPromptSubmit",
  "stop",
])

interface ParsedPayload {
  payload: Record<string, unknown>
  parseError: boolean
}

interface HookContext {
  toolName: string | undefined
  trigger: string | undefined
}

async function readStdinPayloadWithTimeout(
  timeoutMs: number = STDIN_PAYLOAD_TIMEOUT_MS
): Promise<string> {
  const reader = Bun.stdin.stream().getReader()
  const decoder = new TextDecoder()
  let timedOut = false
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true
      // Cancel the active reader so Bun can terminate even if stdin remains open.
      void reader.cancel().catch(() => {})
      reject(
        new Error(`Timed out waiting ${timeoutMs / 1000}s for stdin JSON payload to be received`)
      )
    }, timeoutMs)
    timeoutHandle.unref?.()
  })

  const readAll = (async () => {
    let payload = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      payload += decoder.decode(value, { stream: true })
    }
    payload += decoder.decode()
    return payload
  })().catch((err) => {
    if (timedOut) return ""
    throw err
  })

  try {
    return await Promise.race([readAll, timeout])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    try {
      reader.releaseLock()
    } catch {}
  }
}

function parsePayload(payloadStr: string): ParsedPayload {
  try {
    return {
      payload: JSON.parse(payloadStr || "{}") as Record<string, unknown>,
      parseError: false,
    }
  } catch {
    return { payload: {}, parseError: true }
  }
}

function getHookContext(canonicalEvent: string, payload: Record<string, unknown>): HookContext {
  const toolName = (payload.tool_name ?? payload.toolName) as string | undefined
  const trigger =
    canonicalEvent === "sessionStart"
      ? ((payload.trigger ?? payload.hook_event_name) as string | undefined)
      : undefined
  return { toolName, trigger }
}

function backfillPayloadDefaults(payload: Record<string, unknown>): void {
  if (!payload.cwd) {
    payload.cwd =
      process.env.GEMINI_CWD ||
      process.env.GEMINI_PROJECT_DIR ||
      process.env.CLAUDE_PROJECT_DIR ||
      process.cwd()
  }
  if (!payload.session_id) {
    payload.session_id = process.env.GEMINI_SESSION_ID || "unknown-session"
  }
}

function shouldWarnMissingToolName(
  canonicalEvent: string,
  payload: Record<string, unknown>
): boolean {
  if (payload.tool_name || payload.toolName) return false
  return !TOOL_NAME_OPTIONAL_EVENTS.has(canonicalEvent)
}

async function loadCombinedManifest(cwd: string): Promise<HookGroup[]> {
  let combinedManifest: HookGroup[] = [...manifest]
  const projectSettings = await readProjectSettings(cwd)

  if (projectSettings?.plugins?.length) {
    const pluginResults = await loadAllPlugins(projectSettings.plugins, cwd)
    const pluginHooks = pluginResults.flatMap((r) => r.hooks)
    for (const result of pluginResults) {
      if (result.error) log(`   ⚠ plugin ${result.name}: ${result.error}`)
    }
    if (pluginHooks.length > 0) {
      combinedManifest = [...combinedManifest, ...pluginHooks]
      log(`   loaded ${pluginHooks.length} plugin hook group(s)`)
    }
  }

  if (projectSettings?.hooks?.length) {
    const { resolved, warnings } = resolveProjectHooks(projectSettings.hooks, cwd)
    for (const warning of warnings) log(`   ⚠ ${warning}`)
    if (resolved.length > 0) {
      combinedManifest = [...combinedManifest, ...resolved]
      log(`   loaded ${resolved.length} project-local hook group(s)`)
    }
  }

  return combinedManifest
}

async function enrichPayloadForHooks(
  payload: Record<string, unknown>,
  parseError: boolean,
  fallbackPayloadStr: string
): Promise<string> {
  if (parseError) return fallbackPayloadStr

  let enrichedPayloadStr = fallbackPayloadStr
  const transcriptPath = payload.transcript_path as string | undefined
  if (!transcriptPath) return enrichedPayloadStr

  const summary = await computeTranscriptSummary(transcriptPath)
  if (!summary) return enrichedPayloadStr

  const enriched = merge({}, payload, { _transcriptSummary: summary })
  enrichedPayloadStr = JSON.stringify(enriched)
  log(`   transcript summary: ${summary.toolCallCount} tools, ${summary.bashCommands.length} cmds`)
  return enrichedPayloadStr
}

// ─── Backward-compatible re-exports ─────────────────────────────────────────
// Tests and other consumers import from this file; re-export everything.

export type { DispatchStrategy } from "../dispatch/index.ts"
export {
  applyHookSettingFilters,
  countHooks,
  DISPATCH_ROUTES,
  extractCwd,
  filterDisabledHooks,
  filterPrMergeModeHooks,
  filterStackHooks,
  filterStateHooks,
  formatTrace,
  groupMatches,
  hookCooldownPath,
  isWithinCooldown,
  log,
  logHeader,
  markHookCooldown,
  replayBlocking,
  replayContext,
  replayPreToolUse,
  resolvePrMergeActive,
  runBlocking,
  runContext,
  runHook,
  runPreToolUse,
  SWIZ_NOTIFY_HOOK_FILES,
  type TraceEntry,
  toolMatchesToken,
} from "../dispatch/index.ts"

// ─── Command ────────────────────────────────────────────────────────────────

export const dispatchCommand: Command = {
  name: "dispatch",
  description: "Fan out a hook event to all matching scripts (used by agent configs)",
  usage: "swiz dispatch <event> [agentEventName]",
  options: [
    {
      flags: "<event>",
      description:
        "Canonical event name (preToolUse | postToolUse | stop | sessionStart | userPromptSubmit)",
    },
    {
      flags: "[agentEventName]",
      description: "Agent-translated event name injected into hook output (default: <event>)",
    },
    {
      flags: "replay <event>",
      description: "Replay a captured payload and show a hook-by-hook trace",
    },
    {
      flags: "--json",
      description: "Output trace in machine-readable JSON format (replay mode only)",
    },
  ],
  async run(args) {
    // ─── Replay mode ─────────────────────────────────────────────────────
    if (args[0] === "replay") {
      const canonicalEvent = args[1]
      const jsonMode = args.includes("--json")
      if (!canonicalEvent) {
        throw new Error("Usage: swiz dispatch replay <event> [--json]")
      }

      const payloadStr = await readStdinPayloadWithTimeout()
      const { payload } = parsePayload(payloadStr)
      const { toolName, trigger } = getHookContext(canonicalEvent, payload)

      const matchingGroups = manifest.filter(
        (g) => g.event === canonicalEvent && groupMatches(g, toolName, trigger)
      )
      const filteredGroups = await applyHookSettingFilters(matchingGroups, payload)

      const strategy = DISPATCH_ROUTES[canonicalEvent] ?? "blocking"
      const traces =
        strategy === "preToolUse"
          ? await replayPreToolUse(filteredGroups, payloadStr)
          : strategy === "blocking"
            ? await replayBlocking(filteredGroups, payloadStr, canonicalEvent)
            : await replayContext(filteredGroups, payloadStr)

      formatTrace(canonicalEvent, strategy, filteredGroups.length, traces, jsonMode)
      return
    }

    const canonicalEvent = args[0]
    if (!canonicalEvent) {
      throw new Error("Usage: swiz dispatch <event> [agentEventName]")
    }
    const hookEventName = args[1] ?? canonicalEvent

    const payloadStr = await readStdinPayloadWithTimeout()
    const { payload, parseError } = parsePayload(payloadStr)

    // ── Backfill missing fields from agent environment variables ──
    backfillPayloadDefaults(payload)
    const { toolName, trigger } = getHookContext(canonicalEvent, payload)

    logHeader(canonicalEvent, hookEventName, toolName, trigger)
    log(`   payload: ${payloadStr.length} bytes${parseError ? " ⚠ INVALID JSON" : ""}`)

    // Re-serialize payload if we modified it
    const finalPayloadStr = parseError ? payloadStr : JSON.stringify(payload)

    if (payloadStr.length === 0) {
      log(`   ⚠ EMPTY STDIN — no payload received from agent`)
    } else {
      const keys = orderBy(Object.keys(payload), [(key) => key], ["asc"])
      log(`   keys: ${keys.join(", ")}`)
      if (!payload.session_id) log(`   ⚠ missing session_id`)
      if (shouldWarnMissingToolName(canonicalEvent, payload)) log(`   ⚠ missing tool_name`)
    }

    // ── Best-effort: drain any offline issue mutations before hooks run ──
    const cwd = (payload.cwd as string) ?? process.cwd()
    await tryReplayPendingMutations(cwd)

    // ── Load plugin + project-local hooks and merge with built-in manifest ──
    const combinedManifest = await loadCombinedManifest(cwd)

    const matchingGroups = combinedManifest.filter(
      (g) => g.event === canonicalEvent && groupMatches(g, toolName, trigger)
    )
    const filteredGroups = await applyHookSettingFilters(matchingGroups, payload)

    log(
      `   matched ${matchingGroups.length} group(s) from ${combinedManifest.filter((g) => g.event === canonicalEvent).length} total`
    )
    const skippedHooks = countHooks(matchingGroups) - countHooks(filteredGroups)
    if (skippedHooks > 0) {
      log(`   skipped ${skippedHooks} PR-merge hook(s) (pr-merge-mode disabled)`)
    }

    if (filteredGroups.length === 0) return

    // ── Pre-compute transcript summary for hooks ──────────────────────────
    const enrichedPayloadStr = await enrichPayloadForHooks(payload, parseError, finalPayloadStr)

    const strategy = DISPATCH_ROUTES[canonicalEvent] ?? "blocking"
    switch (strategy) {
      case "preToolUse":
        await runPreToolUse(filteredGroups, enrichedPayloadStr)
        break
      case "blocking":
        await runBlocking(filteredGroups, enrichedPayloadStr, canonicalEvent)
        break
      case "context":
        await runContext(filteredGroups, enrichedPayloadStr, hookEventName)
        break
    }
  },
}
