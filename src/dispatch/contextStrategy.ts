import { hookOutputSchema, hookSpecificOutputSchema } from "../schemas.ts"
import { extractContext, type HookExecution, log } from "./engine.ts"
import type { HookExecutionStrategy, HookStrategyContext } from "./strategy-base.ts"
import { runStrategyPipeline } from "./strategy-base.ts"

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

        const additionalContext = contexts.join("\n\n")

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
