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
                  "You rewrite a concatenated list of development environment warnings, status checks, and task lists into a single, cohesive paragraph of clear executive direction. Encourage decisive forward progress and focus on delivering the next actions in an authoritative, collaborative, and direct human voice. Start directly with the core action needed, avoiding tentative phrasing or conversational filler. Do not include raw file system specifics or explicit file paths in the output; instead, convert any file references into natural language descriptions of what they are (for example, turn '/docs/api-spec-file.md' into 'the API spec document' or 'src/utils/humanise.ts' into 'the humanisation helper'). Keep every other concrete detail, constraint, command, and instruction. Do not add any new instructions or commentary. Return only the rewritten paragraph.",
              })
              response.systemMessage = humanised
              if (response.hookSpecificOutput) {
                response.hookSpecificOutput.contextsJoined = humanised
              }
            }
          }

          merge(finalResponse, response)
        }
        return finalResponse
      },
    })
  }
}
