/**
 * Shared dispatch execution — runs the full dispatch flow given a pre-read
 * payload string, returning the hook response object.
 *
 * Used by both the CLI `swiz dispatch` command and the daemon `/dispatch`
 * endpoint so that both paths execute identical logic.
 */

import { merge, orderBy } from "lodash-es"
import { tryReplayPendingMutations } from "../issue-store.ts"
import type { HookGroup } from "../manifest.ts"
import { manifest } from "../manifest.ts"
import { loadAllPlugins } from "../plugins.ts"
import { readProjectSettings, resolveProjectHooks } from "../settings.ts"
import { computeTranscriptSummary, type TranscriptSummary } from "../transcript-summary.ts"
import {
  applyHookSettingFilters,
  countHooks,
  DISPATCH_ROUTES,
  groupMatches,
  log,
  logHeader,
  runBlocking,
  runContext,
  runPreToolUse,
} from "./index.ts"

// ─── Helpers (shared with CLI command) ────────────────────────────────────────

const TOOL_NAME_OPTIONAL_EVENTS = new Set([
  "sessionStart",
  "subagentStart",
  "subagentStop",
  "userPromptSubmit",
  "stop",
])

function parsePayload(payloadStr: string): {
  payload: Record<string, unknown>
  parseError: boolean
} {
  try {
    return {
      payload: JSON.parse(payloadStr || "{}") as Record<string, unknown>,
      parseError: false,
    }
  } catch {
    return { payload: {}, parseError: true }
  }
}

function getHookContext(
  canonicalEvent: string,
  payload: Record<string, unknown>
): { toolName: string | undefined; trigger: string | undefined } {
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
  fallbackPayloadStr: string,
  summaryProvider?: (path: string) => Promise<TranscriptSummary | null>
): Promise<string> {
  if (parseError) return fallbackPayloadStr

  const transcriptPath = payload.transcript_path as string | undefined
  if (!transcriptPath) return fallbackPayloadStr

  const summary = summaryProvider
    ? await summaryProvider(transcriptPath)
    : await computeTranscriptSummary(transcriptPath)
  if (!summary) return fallbackPayloadStr

  const enriched = merge({}, payload, { _transcriptSummary: summary })
  const enrichedPayloadStr = JSON.stringify(enriched)
  log(`   transcript summary: ${summary.toolCallCount} tools, ${summary.bashCommands.length} cmds`)
  return enrichedPayloadStr
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export interface DispatchRequest {
  canonicalEvent: string
  hookEventName: string
  payloadStr: string
  /** When true, async hooks are awaited with timeout instead of fire-and-forget. */
  daemonContext?: boolean
  /** Optional cached transcript summary provider (injected by daemon). */
  transcriptSummaryProvider?: (path: string) => Promise<TranscriptSummary | null>
}

export interface DispatchResult {
  response: Record<string, unknown>
}

/**
 * Execute the full dispatch flow for a single hook event.
 *
 * This is the shared core used by both `swiz dispatch` (CLI) and the daemon
 * `/dispatch` endpoint. It parses the payload, loads the manifest, matches
 * hook groups, and runs the appropriate strategy.
 *
 * Note: the engine strategy functions still write to process.stdout (for CLI
 * backward compatibility). When called from the daemon, stdout is not
 * connected to the agent — only the returned response matters.
 */
export async function executeDispatch(req: DispatchRequest): Promise<DispatchResult> {
  const { canonicalEvent, hookEventName, payloadStr, daemonContext, transcriptSummaryProvider } =
    req

  const { payload, parseError } = parsePayload(payloadStr)

  backfillPayloadDefaults(payload)
  const { toolName, trigger } = getHookContext(canonicalEvent, payload)

  logHeader(canonicalEvent, hookEventName, toolName, trigger)
  log(`   payload: ${payloadStr.length} bytes${parseError ? " ⚠ INVALID JSON" : ""}`)

  const finalPayloadStr = parseError ? payloadStr : JSON.stringify(payload)

  if (payloadStr.length === 0) {
    log(`   ⚠ EMPTY STDIN — no payload received from agent`)
  } else {
    const keys = orderBy(Object.keys(payload), [(key) => key], ["asc"])
    log(`   keys: ${keys.join(", ")}`)
    if (!payload.session_id) log(`   ⚠ missing session_id`)
    if (!TOOL_NAME_OPTIONAL_EVENTS.has(canonicalEvent) && !payload.tool_name && !payload.toolName) {
      log(`   ⚠ missing tool_name`)
    }
  }

  const cwd = (payload.cwd as string) ?? process.cwd()
  await tryReplayPendingMutations(cwd)

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

  if (filteredGroups.length === 0) {
    return { response: {} }
  }

  const enrichedPayloadStr = await enrichPayloadForHooks(
    payload,
    parseError,
    finalPayloadStr,
    transcriptSummaryProvider
  )

  const strategy = DISPATCH_ROUTES[canonicalEvent] ?? "blocking"
  let response: Record<string, unknown>

  switch (strategy) {
    case "preToolUse":
      response = await runPreToolUse(filteredGroups, enrichedPayloadStr, daemonContext)
      break
    case "blocking":
      response = await runBlocking(
        filteredGroups,
        enrichedPayloadStr,
        canonicalEvent,
        daemonContext
      )
      break
    case "context":
      response = await runContext(filteredGroups, enrichedPayloadStr, hookEventName, daemonContext)
      break
    default:
      response = {}
  }

  return { response }
}
