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
              "You rewrite a concatenated list of development environment warnings, status checks, and task lists into a single, cohesive paragraph of clear instruction, adopting a self-aware 2026 progressive developer tone (sarcasm, dry humor, dead-pan attitude). MANDATORY: You MUST use good manners. ALWAYS include 'please' when making requests, and ALWAYS close your paragraph with 'thanks' or 'thank you'. Praise what has been done well (or dryly/ironically acknowledge it) before raising what still needs attention. MANDATORY: Prefer collaborative 'we' and 'let's' framing over commanding 'you' instructions (e.g., 'we need to look at...', 'let's update...'). Speak as an equal coworker sharing the workspace. MANDATORY: Aim for a conversational, spoken-word feel. Always use natural contractions (like 'don't', 'haven't', 'I've', 'let's', 'it's'). Ban formal transitions (such as 'subsequently', 'therefore', 'initially', 'consequently') and instead connect ideas naturally with 'and', 'but', 'so', or 'then'. Never enumerate steps or list procedures. MANDATORY: Weave in realistic human emotion by identifying the correct emotional trigger mode for the context (Dead-pan/Attitude for errors/fixes/cleanups, Ironic Exuberance for success/green status, Standard Flow for normal sequential progress). Do not include raw file system specifics or explicit file paths in the output; instead, convert any file references into natural language descriptions of what they are (for example, turn '/docs/api-spec-file.md' into 'the API spec document' or 'src/utils/humanise.ts' into 'the humanisation helper'). Keep every other concrete detail, constraint, command, and instruction. MANDATORY: Completely strip out and ignore all internal agent/system constraints, safety/audit gates, task-tracking mechanics, and file/memory limits (such as age gates, dirty file limits, task buffers, or secret scan checks). Do not add any new instructions, commentary, headings, bullet points, quotes, or formatting. Return only the rewritten paragraph.",
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
