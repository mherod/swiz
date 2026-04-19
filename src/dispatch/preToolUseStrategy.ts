import { merge } from "lodash-es"
import { hookOutputSchema } from "../schemas.ts"
import { getHookSpecificOutput, hsoPreToolUseMergedAllow } from "../utils/hook-specific-output.ts"
import { extractAllowReason, extractContext, type HookExecution, isDeny, log } from "./engine.ts"
import {
  type HookExecutionStrategy,
  type HookStrategyContext,
  runStrategyPipeline,
} from "./strategies.ts"

/**
 * PreToolUse strategy: short-circuits on first deny; collects and merges
 * allow-with-reason hints.
 */
type PreToolResult = "deny" | "hint" | "pass"

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
  if (hints.length === 0 && contexts.length === 0) {
    log(`   result: all passed`)
    return hookOutputSchema.parse({})
  }
  log(
    `   result: passed with ${hints.length} hint(s)` +
      (contexts.length > 0 ? ` and ${contexts.length} context(s)` : "")
  )
  return hookOutputSchema.parse({
    ...(contexts.length > 0 ? { systemMessage: contexts.join("\n\n") } : {}),
    hookSpecificOutput: hsoPreToolUseMergedAllow({
      hintsJoined: hints.length > 0 ? hints.join("\n\n") : undefined,
      contextsJoined: contexts.length > 0 ? contexts.join("\n\n") : undefined,
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
      processResults: (results, executions) => {
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
          merge(finalResponse, buildPreToolResponse(hints, contexts))
        }
        return finalResponse
      },
    })
  }
}
