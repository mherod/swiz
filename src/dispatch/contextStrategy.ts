import { hookOutputSchema, hookSpecificOutputSchema } from "../schemas.ts"
import { extractContext, log } from "./engine.ts"
import {
  type HookExecutionStrategy,
  type HookStrategyContext,
  runStrategyPipeline,
} from "./strategy-base.ts"

/**
 * Context strategy: runs all hooks, merges additionalContext for
 * sessionStart and userPromptSubmit events.
 */
export class ContextStrategy implements HookExecutionStrategy {
  async execute(ctx: HookStrategyContext): Promise<Record<string, any>> {
    const { hookEventName } = ctx
    const contexts: string[] = []

    return runStrategyPipeline(ctx, {
      processResults: async (results, executions) => {
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
          const ctxText = extractContext(resp)
          if (ctxText) {
            execution.status = "allow-with-reason"
            contexts.push(ctxText)
            log(`   ✓ ${execution.file} (context: ${ctxText.slice(0, 100)})`)
          } else {
            log(`   ✓ ${execution.file} (no context extracted)`)
          }
          executions.push(execution)
        }

        if (contexts.length === 0) {
          log(`   result: no contexts to merge`)
          return hookOutputSchema.parse({})
        }

        const mergedContext = contexts.join("\n\n")
        let humaniseEnabled = false
        let sessionId: string | undefined
        let transcriptPath: string | undefined
        try {
          const payload = JSON.parse(ctx.enrichedPayloadStr)
          humaniseEnabled = payload._effectiveSettings?.humaniseAutoSteer ?? false
          sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined
          transcriptPath =
            typeof payload.transcript_path === "string" ? payload.transcript_path : undefined
        } catch {}

        let additionalContext = mergedContext
        if (humaniseEnabled && mergedContext.trim()) {
          const { humaniseText, STRATEGY_HUMANISE_SYSTEM_PROMPT } = await import(
            "../utils/humanise.ts"
          )
          additionalContext = await humaniseText(mergedContext, {
            systemPrompt: STRATEGY_HUMANISE_SYSTEM_PROMPT,
            sessionId,
            transcriptPath,
          })
        }

        log(`   result: merged ${contexts.length} context(s), hookEventName=${hookEventName}`)
        return hookOutputSchema.parse({
          hookSpecificOutput: hookSpecificOutputSchema.parse({
            hookEventName,
            additionalContext,
          }),
        })
      },
    })
  }
}
