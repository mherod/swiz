import { hookOutputSchema, hookSpecificOutputSchema } from "../schemas.ts"
import { extractContext, log } from "./engine.ts"
import {
  type HookExecutionStrategy,
  type HookStrategyContext,
  runStrategyPipeline,
} from "./strategies.ts"

/**
 * Context strategy: runs all hooks, merges additionalContext for
 * sessionStart and userPromptSubmit events.
 */
export class ContextStrategy implements HookExecutionStrategy {
  async execute(ctx: HookStrategyContext): Promise<Record<string, any>> {
    const { hookEventName } = ctx
    const contexts: string[] = []

    return runStrategyPipeline(ctx, {
      processResults: (results, executions) => {
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
        log(`   result: merged ${contexts.length} context(s), hookEventName=${hookEventName}`)
        return hookOutputSchema.parse({
          hookSpecificOutput: hookSpecificOutputSchema.parse({
            hookEventName,
            additionalContext: contexts.join("\n\n"),
          }),
        })
      },
    })
  }
}
