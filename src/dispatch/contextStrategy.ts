import { hookOutputSchema, hookSpecificOutputSchema } from "../schemas.ts"
import { shouldHumaniseContextOutput } from "./context-humanise.ts"
import { extractContext, type HookExecution, log } from "./engine.ts"
import type { HookExecutionStrategy, HookStrategyContext } from "./strategy-base.ts"
import { runStrategyPipeline } from "./strategy-base.ts"

interface HumaniseContextParams {
  humaniseEnabled: boolean
  sessionId?: string
  transcriptPath?: string
  withinGrace: boolean
}

function collectContextsFromResults(
  results: Array<{ execution: HookExecution; parsed: Record<string, any> | null }>,
  executions: HookExecution[]
): string[] {
  const contexts = new Set<string>()
  for (const { execution, parsed: resp } of results) {
    if (execution.status === "skipped" || execution.status === "aborted") {
      executions.push(execution)
      continue
    }
    if (!resp) {
      log(`   ✓ ${execution.file} (no output)`)
      executions.push(execution)
      continue
    }
    const ctxText = collectHookContext(resp)
    if (ctxText) {
      execution.status = "allow-with-reason"
      for (const text of ctxText) contexts.add(text)
      log(`   ✓ ${execution.file} (context: ${ctxText.join("\n\n").slice(0, 100)})`)
    } else {
      log(`   ✓ ${execution.file} (no context extracted)`)
    }
    executions.push(execution)
  }
  return [...contexts]
}

/** Context routes preserve distinct directives and details, unlike preview-only consumers. */
function collectHookContext(response: Record<string, any>): string[] | null {
  const systemMessage =
    typeof response.systemMessage === "string" ? response.systemMessage.trim() : ""
  const fields = [systemMessage, extractContext(response)].filter((text): text is string => !!text)
  return fields.length > 0 ? fields : null
}

async function resolveHumaniseParams(enrichedPayloadStr: string): Promise<HumaniseContextParams> {
  let humaniseEnabled = false
  let sessionId: string | undefined
  let transcriptPath: string | undefined
  let withinGrace = false
  try {
    const payload = JSON.parse(enrichedPayloadStr)
    humaniseEnabled = payload._effectiveSettings?.humaniseAutoSteer ?? false
    sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined
    transcriptPath =
      typeof payload.transcript_path === "string" ? payload.transcript_path : undefined
    const { isWithinUserMessageGrace } = await import("../tasks/task-governance-grace.ts")
    withinGrace = await isWithinUserMessageGrace(payload)
  } catch {}
  return { humaniseEnabled, sessionId, transcriptPath, withinGrace }
}

async function applyContextHumanisation(
  mergedContext: string,
  canonicalEvent: string,
  params: HumaniseContextParams
): Promise<string> {
  if (
    !shouldHumaniseContextOutput({
      canonicalEvent,
      humaniseEnabled: params.humaniseEnabled,
      withinGrace: params.withinGrace,
    }) ||
    !mergedContext.trim()
  ) {
    return mergedContext
  }
  const { humaniseText, STRATEGY_HUMANISE_SYSTEM_PROMPT } = await import("../utils/humanise.ts")
  return humaniseText(mergedContext, {
    systemPrompt: STRATEGY_HUMANISE_SYSTEM_PROMPT,
    sessionId: params.sessionId,
    transcriptPath: params.transcriptPath,
  })
}

/**
 * Runs hooks for every context-routed event in DISPATCH_ROUTES, preserving each
 * distinct systemMessage and additionalContext once. The shared pipeline's final
 * agent sanitizer owns envelope compatibility, including confirmed compact rejections.
 */
export class ContextStrategy implements HookExecutionStrategy {
  async execute(ctx: HookStrategyContext): Promise<Record<string, any>> {
    const { hookEventName } = ctx

    return runStrategyPipeline(ctx, {
      processResults: async (results, executions) => {
        const contexts = collectContextsFromResults(results, executions)

        if (contexts.length === 0) {
          log(`   result: no contexts to merge`)
          return hookOutputSchema.parse({})
        }

        const mergedContext = contexts.join("\n\n")
        const params = await resolveHumaniseParams(ctx.enrichedPayloadStr)
        const additionalContext = await applyContextHumanisation(
          mergedContext,
          ctx.canonicalEvent,
          params
        )

        log(`   result: merged ${contexts.length} context(s), hookEventName=${hookEventName}`)
        return hookOutputSchema.parse({
          systemMessage: additionalContext,
          hookSpecificOutput: hookSpecificOutputSchema.parse({
            hookEventName,
            additionalContext,
          }),
        })
      },
    })
  }
}
