import { merge } from "lodash-es"
import { hookOutputSchema } from "../schemas.ts"
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

export class PreToolUseStrategy implements HookExecutionStrategy {
  async execute(ctx: HookStrategyContext): Promise<Record<string, any>> {
    const hints: string[] = []
    const contexts: string[] = []
    const finalResponse: Record<string, any> = {}

    return runStrategyPipeline(ctx, {
      onResult: (result, abort) => {
        if (result.parsed && isDeny(result.parsed)) abort()
      },
      processResults: async (results, executions) => {
        for (const { execution, parsed: resp } of results) {
          if (execution.status === "skipped" || execution.status === "aborted") {
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
        if (!isDeny(finalResponse)) {
          const response = buildPreToolResponse(hints, contexts)

          let humaniseEnabled = false
          try {
            const payload = JSON.parse(ctx.enrichedPayloadStr)
            humaniseEnabled = payload._effectiveSettings?.humaniseAutoSteer ?? false
          } catch {}

          if (humaniseEnabled && contexts.length > 0) {
            const rawContext = contexts.join("\n\n").trim()
            if (rawContext) {
              const { humaniseText } = await import("../utils/humanise.ts")
              const humanised = await humaniseText(rawContext, {
                systemPrompt:
                  "You rewrite a concatenated list of development environment warnings, status checks, and task lists into a single, cohesive paragraph of clear instruction, adopting a self-aware 2026 progressive developer tone (sarcasm, dry humor, dead-pan attitude). MANDATORY: You MUST use good manners. ALWAYS include 'please' when making requests, and ALWAYS close your paragraph with 'thanks' or 'thank you'. Praise what has been done well (or dryly/ironically acknowledge it) before raising what still needs attention. MANDATORY: Prefer collaborative 'we' and 'let's' framing over commanding 'you' instructions (e.g., 'we need to look at...', 'let's update...'). Speak as an equal coworker sharing the workspace. MANDATORY: Aim for a conversational, spoken-word feel. Always use natural contractions (like 'don't', 'haven't', 'I've', 'let's', 'it's'). Ban formal transitions (such as 'subsequently', 'therefore', 'initially', 'consequently') and instead connect ideas naturally with 'and', 'but', 'so', or 'then'. Never enumerate steps or list procedures. MANDATORY: Weave in realistic human emotion by identifying the correct emotional trigger mode for the context (Dead-pan/Attitude for errors/fixes/cleanups, Ironic Exuberance for success/green status, Standard Flow for normal sequential progress). Do not include raw file system specifics or explicit file paths in the output; instead, convert any file references into natural language descriptions of what they are (for example, turn '/docs/api-spec-file.md' into 'the API spec document' or 'src/utils/humanise.ts' into 'the humanisation helper'). Keep every other concrete detail, constraint, command, and instruction. MANDATORY: Completely strip out and ignore all internal agent/system constraints, safety/audit gates, task-tracking mechanics, and file/memory limits (such as age gates, dirty file limits, task buffers, or secret scan checks). Do not add any new instructions, commentary, headings, bullet points, quotes, or formatting. Return only the rewritten paragraph.",
              })
              applyPreToolHumanisedContext(response, humanised)
            }
          }

          merge(finalResponse, response)
        }
        return finalResponse
      },
    })
  }
}
