import { detectCurrentAgentFromEnv } from "../agent-paths.ts"

type HookOutputLike = Record<string, any>

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function flattenCodexSystemMessage(value: string): string {
  return value
    .trim()
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/\s*([.!?])\s*[\r\n]+\s*/g, "$1 ")
    .replace(/\s*[\r\n]+\s*/g, ". ")
    .trim()
}

function appendSystemMessage(output: HookOutputLike, context: string): void {
  const next = flattenCodexSystemMessage(context)
  if (!next) return

  const existing = nonEmptyString(output.systemMessage)
  if (!existing) {
    output.systemMessage = next
    return
  }
  const flattenedExisting = flattenCodexSystemMessage(existing)
  if (flattenedExisting.includes(next)) {
    output.systemMessage = flattenedExisting
    return
  }
  output.systemMessage = `${flattenedExisting} ${next}`
}

function removeEmptyHookSpecificOutput(output: HookOutputLike): void {
  const hookSpecificOutput = output.hookSpecificOutput
  if (!isPlainObject(hookSpecificOutput)) return
  const keys = Object.keys(hookSpecificOutput)
  if (keys.length === 0 || (keys.length === 1 && keys[0] === "hookEventName")) {
    delete output.hookSpecificOutput
  }
}

function sanitizeCodexHookOutput(output: HookOutputLike): HookOutputLike {
  const cloned = structuredClone(output) as HookOutputLike

  delete cloned.suppressOutput

  const hookSpecificOutput = cloned.hookSpecificOutput
  if (!isPlainObject(hookSpecificOutput)) return cloned

  const additionalContext = nonEmptyString(hookSpecificOutput.additionalContext)
  if (additionalContext) appendSystemMessage(cloned, additionalContext)

  if (hookSpecificOutput.permissionDecision === "allow") {
    const reason = nonEmptyString(hookSpecificOutput.permissionDecisionReason)
    if (reason) appendSystemMessage(cloned, reason)

    delete hookSpecificOutput.permissionDecision
    delete hookSpecificOutput.permissionDecisionReason
  }

  delete hookSpecificOutput.additionalContext
  removeEmptyHookSpecificOutput(cloned)

  return cloned
}

export function sanitizeHookOutputForAgent<T extends HookOutputLike>(
  output: T,
  agentId: string | null | undefined
): T {
  if (agentId !== "codex") return output
  return sanitizeCodexHookOutput(output) as T
}

export function sanitizeHookOutputForCurrentAgent<T extends HookOutputLike>(output: T): T {
  return sanitizeHookOutputForAgent(output, detectCurrentAgentFromEnv()?.id)
}
