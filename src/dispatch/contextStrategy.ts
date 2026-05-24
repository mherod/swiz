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
        try {
          const payload = JSON.parse(ctx.enrichedPayloadStr)
          humaniseEnabled = payload._effectiveSettings?.humaniseAutoSteer ?? false
        } catch {}

        let additionalContext = mergedContext
        if (humaniseEnabled && mergedContext.trim()) {
          const { humaniseText } = await import("../utils/humanise.ts")
          additionalContext = await humaniseText(mergedContext, {
            systemPrompt:
              "You rewrite a concatenated list of development environment warnings, status checks, and task lists into a single, cohesive paragraph of clear executive direction. Encourage decisive forward progress and focus on delivering the next actions in an authoritative, collaborative, and direct human voice. Start directly with the core action needed, avoiding tentative phrasing or conversational filler. Do not include raw file system specifics or explicit file paths in the output; instead, convert any file references into natural language descriptions of what they are (for example, turn '/docs/api-spec-file.md' into 'the API spec document' or 'src/utils/humanise.ts' into 'the humanisation helper'). Keep every other concrete detail, constraint, command, and instruction. Do not add any new instructions or commentary. Return only the rewritten paragraph.",
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
