import { merge } from "lodash-es"
import { hookOutputSchema } from "../schemas.ts"
import { isFileEditTool } from "../tool-matchers.ts"
import { getHookSpecificOutput, hsoPreToolUseMergedAllow } from "../utils/hook-specific-output.ts"
import { extractAllowReason, extractContext, type HookExecution, isDeny, log } from "./engine.ts"
import {
  type HookExecutionStrategy,
  type HookStrategyContext,
  runStrategyPipeline,
} from "./strategy-base.ts"

/**
 * PreToolUse strategy: short-circuits on first deny; collects and merges
 * allow-with-reason hints.
 */
type PreToolResult = "deny" | "hint" | "pass"

const MODE_HINT_RE = new RegExp(
  "^(?:continue|stay|remain|keep going|proceed|carry on|move on|press on)\\s+" +
    "(?:in|with)\\s+(.+?)(?:\\s+mode)?(?:\\.|:|$)",
  "i"
)

function normalizedHintKey(text: string): string {
  return text.trim().replace(/\s+/g, " ")
}

function uniqueNonEmpty(items: readonly string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const item of items) {
    const key = normalizedHintKey(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    unique.push(item)
  }
  return unique
}

function modeHintLabel(hint: string): string | null {
  const match = hint.match(MODE_HINT_RE)
  if (!match?.[1]) return null
  return match[1]
    .replace(/\s+enabled$/i, "")
    .replace(/\s+mode$/i, "")
    .trim()
}

export function preparePreToolHints(
  hints: readonly string[],
  contexts: readonly string[]
): string[] {
  const contextKeys = new Set(contexts.map(normalizedHintKey).filter(Boolean))
  const uniqueHints = uniqueNonEmpty(hints).filter(
    (hint) => !contextKeys.has(normalizedHintKey(hint))
  )
  const modeLabels: string[] = []
  const nonModeHints: string[] = []

  for (const hint of uniqueHints) {
    const label = modeHintLabel(hint)
    if (label) {
      modeLabels.push(label)
    } else {
      nonModeHints.push(hint)
    }
  }

  if (modeLabels.length < 3) return uniqueHints

  return [...nonModeHints, `Active guardrails: ${uniqueNonEmpty(modeLabels).join("; ")}.`]
}

function classifyAllowHint(
  resp: Record<string, any>,
  execution: HookExecution,
  hints: string[],
  contexts: string[]
): boolean {
  const hso = getHookSpecificOutput(resp)
  const reason = extractAllowReason(resp)
  const context = extractContext(resp)
  if (hso?.permissionDecision !== "allow" || (!reason && !context)) return false
  execution.status = "allow-with-reason"
  if (reason) hints.push(reason)
  if (context) contexts.push(context)
  log(`   ~ ${execution.file} (hint: ${(reason ?? context ?? "").slice(0, 100)})`)
  return true
}

/** Deny reason from any of the shapes hooks use for PreToolUse denials. */
function extractDenyReason(resp: Record<string, any>): string | null {
  const hso = getHookSpecificOutput(resp)
  const candidates = [
    hso?.permissionDecisionReason,
    resp.reason,
    resp.stopReason,
    resp.systemMessage,
    hso?.additionalContext,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim()
  }
  return null
}

function hasTopLevelReason(resp: Record<string, any>): boolean {
  return typeof resp.reason === "string" && !!resp.reason.trim()
}

function hasCanonicalDenyReason(hso: Record<string, any> | undefined, reason: string): boolean {
  return hso?.permissionDecision === "deny" && hso.permissionDecisionReason === reason
}

/**
 * Ensure every accepted PreToolUse deny shape has an agent-visible reason.
 * Existing reasons remain byte-for-byte unchanged; only incomplete legacy or
 * external outputs receive the deterministic hook-naming fallback.
 */
export function normalizePreToolDenyReason(
  resp: Record<string, any>,
  hookFile: string
): string | null {
  if (!isDeny(resp)) return null

  const hso = getHookSpecificOutput(resp)
  const existing = extractDenyReason(resp)
  const reason =
    existing ??
    `Blocked by ${hookFile}. The hook supplied no retry guidance; resolve this hook's requirement before retrying.`

  if (!existing) {
    resp.reason = reason
    resp.systemMessage = reason
    if (hso?.permissionDecision === "deny") hso.permissionDecisionReason = reason
  } else if (!hasTopLevelReason(resp) && !hasCanonicalDenyReason(hso, reason)) {
    resp.reason = reason
  }

  return reason
}

/**
 * How file-edit denies are softened for the current call:
 * - "skill-active": a skill is driving the session; every edit deny downgrades
 *   (edit gates firing mid-skill create catch-22s).
 * - "edit-protected": any other file edit; denies downgrade to advisory context
 *   except from skill-enforcement gates, whose mandates keep blocking.
 */
export type FileEditDenyDowngrade = "skill-active" | "edit-protected" | null

/** Hooks that enforce "a skill must be invoked for this pattern" — their denies
 * survive the edit-protected downgrade so skill mandates keep working. */
const SKILL_GATE_HOOK_RE = /skill|update-memory/

export function isSkillGateHook(hookFile: string): boolean {
  return SKILL_GATE_HOOK_RE.test(hookFile)
}

/**
 * File edits are never hard-blocked. While a skill is recently active every
 * deny downgrades; otherwise all denies downgrade except skill-enforcement
 * gates, which must keep their invoke-the-skill-first mandate.
 */
export async function resolveFileEditDenyDowngrade(
  payload: Record<string, any>,
  cwd: string
): Promise<FileEditDenyDowngrade> {
  const toolName = payload.tool_name ?? payload.toolName
  if (typeof toolName !== "string" || !isFileEditTool(toolName)) return null
  try {
    const { isAnySkillRecentlyActive } = await import("../skill-utils.ts")
    if (await isAnySkillRecentlyActive(payload, cwd)) return "skill-active"
  } catch {}
  return "edit-protected"
}

export async function shouldDowngradeFileEditDenies(
  payload: Record<string, any>,
  cwd: string
): Promise<boolean> {
  return (await resolveFileEditDenyDowngrade(payload, cwd)) === "skill-active"
}

/**
 * Fold hook results into hints/contexts, honouring the deny-downgrade mode.
 * Merges the first surviving deny into `finalResponse` and stops there.
 */
interface PreToolAccumulator {
  hints: string[]
  contexts: string[]
  downgradeMode: FileEditDenyDowngrade
  finalResponse: Record<string, any>
}

function downgradesDeny(mode: FileEditDenyDowngrade, hookFile: string): boolean {
  if (mode === "skill-active") return true
  if (mode === "edit-protected") return !isSkillGateHook(hookFile)
  return false
}

export function collectPreToolResults(
  results: Array<{ execution: HookExecution; parsed: Record<string, any> | null }>,
  executions: HookExecution[],
  acc: PreToolAccumulator
): void {
  const { hints, contexts, downgradeMode, finalResponse } = acc
  for (const { execution, parsed: resp } of results) {
    if (execution.status === "skipped" || execution.status === "aborted") {
      executions.push(execution)
      continue
    }
    if (resp) normalizePreToolDenyReason(resp, execution.file)
    if (resp && isDeny(resp) && downgradesDeny(downgradeMode, execution.file)) {
      execution.status = "allow-with-reason"
      const reason = extractDenyReason(resp)
      if (reason) contexts.push(reason)
      log(`   ~ ${execution.file} (deny downgraded: ${downgradeMode}, file edit)`)
      executions.push(execution)
      continue
    }
    const classification = classifyPreToolResult(execution, resp, hints, contexts)
    executions.push(execution)
    if (classification === "deny") {
      merge(finalResponse, resp)
      break
    }
  }
}

function classifyPreToolResult(
  execution: HookExecution,
  resp: Record<string, any> | null,
  hints: string[],
  contexts: string[]
): PreToolResult {
  if (resp && isDeny(resp)) {
    execution.status = "deny"
    log(`   ✗ DENY from ${execution.file}`)
    return "deny"
  }
  if (resp && classifyAllowHint(resp, execution, hints, contexts)) return "hint"
  log(`   ✓ ${execution.file} (${resp ? "allow" : "no output"})`)
  return "pass"
}

function buildPreToolResponse(hints: string[], contexts: string[]): Record<string, any> {
  const cleanContexts = uniqueNonEmpty(contexts)
  const cleanHints = preparePreToolHints(hints, cleanContexts)

  if (cleanHints.length === 0 && cleanContexts.length === 0) {
    log(`   result: all passed`)
    return hookOutputSchema.parse({})
  }
  log(
    `   result: passed with ${cleanHints.length} hint(s)` +
      (cleanContexts.length > 0 ? ` and ${cleanContexts.length} context(s)` : "")
  )
  return hookOutputSchema.parse({
    ...(cleanContexts.length > 0 ? { systemMessage: cleanContexts.join("\n\n") } : {}),
    hookSpecificOutput: hsoPreToolUseMergedAllow({
      hintsJoined: cleanHints.length > 0 ? cleanHints.join("\n\n") : undefined,
      contextsJoined: cleanContexts.length > 0 ? cleanContexts.join("\n\n") : undefined,
    }),
  })
}

/**
 * Replace the merged allow response's context fields with humanised text.
 * Must write `additionalContext` (the agent-recognized PreToolUse field) — writing
 * any other key leaks an unknown field into `hookSpecificOutput`, which the agent
 * rejects as "hook returned invalid pre-tool-use JSON output" (schemas are looseObject,
 * so the bad key survives boundary validation).
 */
export function applyPreToolHumanisedContext(
  response: Record<string, any>,
  humanised: string
): void {
  response.systemMessage = humanised
  if (response.hookSpecificOutput) {
    response.hookSpecificOutput.additionalContext = humanised
  }
}

/**
 * Humanise the merged allow response's context, unless humanisation is off or
 * we are inside the post-user-message grace window — the mechanical context
 * voice stays visually distinct from the user's own messages while they are
 * actively present.
 */
async function maybeHumanisePreToolContexts(
  response: Record<string, any>,
  payload: Record<string, any>,
  contexts: readonly string[]
): Promise<void> {
  if (contexts.length === 0) return
  let humaniseEnabled = false
  let sessionId: string | undefined
  let transcriptPath: string | undefined
  let withinGrace = false
  try {
    humaniseEnabled = payload._effectiveSettings?.humaniseAutoSteer ?? false
    sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined
    transcriptPath =
      typeof payload.transcript_path === "string" ? payload.transcript_path : undefined
    const { isWithinUserMessageGrace } = await import("../tasks/task-governance-grace.ts")
    withinGrace = await isWithinUserMessageGrace(payload)
  } catch {}

  if (!humaniseEnabled || withinGrace) return
  const rawContext = contexts.join("\n\n").trim()
  if (!rawContext) return
  const { humaniseText, STRATEGY_HUMANISE_SYSTEM_PROMPT } = await import("../utils/humanise.ts")
  const humanised = await humaniseText(rawContext, {
    systemPrompt: STRATEGY_HUMANISE_SYSTEM_PROMPT,
    sessionId,
    transcriptPath,
  })
  applyPreToolHumanisedContext(response, humanised)
}

export class PreToolUseStrategy implements HookExecutionStrategy {
  async execute(ctx: HookStrategyContext): Promise<Record<string, any>> {
    const hints: string[] = []
    const contexts: string[] = []
    const finalResponse: Record<string, any> = {}

    let payload: Record<string, any> = {}
    try {
      payload = JSON.parse(ctx.enrichedPayloadStr)
    } catch {}
    const downgradeMode = await resolveFileEditDenyDowngrade(payload, ctx.cwd)

    return runStrategyPipeline(ctx, {
      onResult: (result, abort) => {
        // Only abort early when no downgrade mode could rescue any deny; in
        // edit-protected mode a skill-gate deny may still win, but hooks are
        // cheap relative to a wrongly-cancelled downgrade pass.
        if (!downgradeMode && result.parsed && isDeny(result.parsed)) abort()
      },
      processResults: async (results, executions) => {
        collectPreToolResults(results, executions, {
          hints,
          contexts,
          downgradeMode,
          finalResponse,
        })
        if (!isDeny(finalResponse)) {
          const response = buildPreToolResponse(hints, contexts)
          await maybeHumanisePreToolContexts(response, payload, contexts)
          merge(finalResponse, response)
        }
        return finalResponse
      },
    })
  }
}
