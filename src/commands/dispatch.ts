/**
 * Dispatch command — CLI entry point for `swiz dispatch <event>`.
 *
 * The heavy lifting (filters, engine, replay) lives in src/dispatch/.
 * This file handles CLI parsing, plugin loading, transcript enrichment,
 * and re-exports all public symbols for backward compatibility.
 */

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
  runBlocking,
  runContext,
  runHook,
  runPreToolUse,
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

      const payloadStr = await new Response(Bun.stdin).text()
      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse(payloadStr) as Record<string, unknown>
      } catch {}

      const toolName = (payload.tool_name ?? payload.toolName) as string | undefined
      const trigger =
        canonicalEvent === "sessionStart"
          ? ((payload.trigger ?? payload.hook_event_name) as string | undefined)
          : undefined

      const matchingGroups = manifest.filter(
        (g) => g.event === canonicalEvent && groupMatches(g, toolName, trigger)
      )
      const filteredGroups = await applyHookSettingFilters(matchingGroups, payload)

      const strategy = DISPATCH_ROUTES[canonicalEvent] ?? "blocking"

      let traces: Awaited<ReturnType<typeof replayPreToolUse>>
      switch (strategy) {
        case "preToolUse":
          traces = await replayPreToolUse(filteredGroups, payloadStr)
          break
        case "blocking":
          traces = await replayBlocking(filteredGroups, payloadStr)
          break
        case "context":
          traces = await replayContext(filteredGroups, payloadStr)
          break
      }

      formatTrace(canonicalEvent, strategy, filteredGroups.length, traces, jsonMode)
      return
    }

    const canonicalEvent = args[0]
    if (!canonicalEvent) {
      throw new Error("Usage: swiz dispatch <event> [agentEventName]")
    }
    const hookEventName = args[1] ?? canonicalEvent

    const payloadStr = await new Response(Bun.stdin).text()
    let payload: Record<string, unknown> = {}
    let parseError = false
    try {
      payload = JSON.parse(payloadStr) as Record<string, unknown>
    } catch {
      parseError = true
    }

    const toolName = (payload.tool_name ?? payload.toolName) as string | undefined
    const trigger =
      canonicalEvent === "sessionStart"
        ? ((payload.trigger ?? payload.hook_event_name) as string | undefined)
        : undefined

    logHeader(canonicalEvent, hookEventName, toolName, trigger)
    log(`   payload: ${payloadStr.length} bytes${parseError ? " ⚠ INVALID JSON" : ""}`)
    if (payloadStr.length === 0) {
      log(`   ⚠ EMPTY STDIN — no payload received from agent`)
    } else {
      const keys = Object.keys(payload)
      log(`   keys: ${keys.join(", ")}`)
      if (!payload.session_id) log(`   ⚠ missing session_id`)
      if (
        !payload.tool_name &&
        !payload.toolName &&
        canonicalEvent !== "sessionStart" &&
        canonicalEvent !== "subagentStart" &&
        canonicalEvent !== "subagentStop" &&
        canonicalEvent !== "userPromptSubmit" &&
        canonicalEvent !== "stop"
      )
        log(`   ⚠ missing tool_name`)
    }

    // ── Best-effort: drain any offline issue mutations before hooks run ──
    const cwd = (payload.cwd as string) ?? process.cwd()
    await tryReplayPendingMutations(cwd)

    // ── Load plugin + project-local hooks and merge with built-in manifest ──
    let combinedManifest: HookGroup[] = [...manifest]
    const projectSettings = await readProjectSettings(cwd)
    if (projectSettings?.plugins?.length) {
      const pluginResults = await loadAllPlugins(projectSettings.plugins, cwd)
      const pluginHooks = pluginResults.flatMap((r) => r.hooks)
      for (const r of pluginResults) {
        if (r.error) log(`   ⚠ plugin ${r.name}: ${r.error}`)
      }
      if (pluginHooks.length > 0) {
        combinedManifest = [...combinedManifest, ...pluginHooks]
        log(`   loaded ${pluginHooks.length} plugin hook group(s)`)
      }
    }
    if (projectSettings?.hooks?.length) {
      const { resolved, warnings } = resolveProjectHooks(projectSettings.hooks, cwd)
      for (const w of warnings) log(`   ⚠ ${w}`)
      if (resolved.length > 0) {
        combinedManifest = [...combinedManifest, ...resolved]
        log(`   loaded ${resolved.length} project-local hook group(s)`)
      }
    }

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
    let enrichedPayloadStr = payloadStr
    const transcriptPath = payload.transcript_path as string | undefined
    if (transcriptPath && !parseError) {
      const summary = await computeTranscriptSummary(transcriptPath)
      if (summary) {
        const enriched = { ...payload, _transcriptSummary: summary }
        enrichedPayloadStr = JSON.stringify(enriched)
        log(
          `   transcript summary: ${summary.toolCallCount} tools, ${summary.bashCommands.length} cmds`
        )
      }
    }

    const strategy = DISPATCH_ROUTES[canonicalEvent] ?? "blocking"
    switch (strategy) {
      case "preToolUse":
        await runPreToolUse(filteredGroups, enrichedPayloadStr)
        break
      case "blocking":
        await runBlocking(filteredGroups, enrichedPayloadStr)
        break
      case "context":
        await runContext(filteredGroups, enrichedPayloadStr, hookEventName)
        break
    }
  },
}
