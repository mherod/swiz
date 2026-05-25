import { detectCurrentAgentFromEnv } from "../agent-paths.ts"
import { type AgentDef, getAgent, translateToolNamesInText } from "../agents.ts"

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
  } else if (hookSpecificOutput.permissionDecision === "deny") {
    const reason =
      nonEmptyString(hookSpecificOutput.permissionDecisionReason) ??
      nonEmptyString(cloned.reason) ??
      nonEmptyString(cloned.systemMessage) ??
      "Blocked by Swiz hook."

    hookSpecificOutput.permissionDecisionReason = reason
    cloned.decision = "block"
    cloned.reason = reason
  }

  delete hookSpecificOutput.additionalContext
  removeEmptyHookSpecificOutput(cloned)

  return cloned
}

/** Agent-visible free-text fields that may embed canonical tool names. */
const TOOL_NAME_TEXT_FIELDS = ["reason", "systemMessage", "stopReason"] as const
const NESTED_TOOL_NAME_TEXT_FIELDS = ["additionalContext", "permissionDecisionReason"] as const

/**
 * Rewrite canonical tool names (Bash/Edit/TaskCreate…) in agent-visible text
 * fields to the agent's own tool names, so no foreign tool name leaks to the
 * agent. No-op for Claude (canonical === Claude names) and alias-less agents;
 * returns the original reference unchanged when nothing is translated so callers
 * relying on identity (e.g. Claude pass-through) keep working.
 */
function translateHookOutputToolNames<T extends HookOutputLike>(
  output: T,
  agent: AgentDef | undefined
): T {
  if (!agent || agent.id === "claude") return output
  if (Object.keys(agent.toolAliases).length === 0 && !agent.taskToolAliases) return output

  let result: HookOutputLike | null = null
  const ensureClone = (): HookOutputLike => {
    result ??= structuredClone(output)
    return result
  }

  for (const field of TOOL_NAME_TEXT_FIELDS) {
    const value = output[field]
    if (typeof value !== "string" || !value) continue
    const translated = translateToolNamesInText(value, agent)
    if (translated !== value) ensureClone()[field] = translated
  }

  const hookSpecificOutput = output.hookSpecificOutput
  if (isPlainObject(hookSpecificOutput)) {
    for (const field of NESTED_TOOL_NAME_TEXT_FIELDS) {
      const value = hookSpecificOutput[field]
      if (typeof value !== "string" || !value) continue
      const translated = translateToolNamesInText(value, agent)
      if (translated !== value) ensureClone().hookSpecificOutput[field] = translated
    }
  }

  return (result ?? output) as T
}

export function sanitizeHookOutputForAgent<T extends HookOutputLike>(
  output: T,
  agentId: string | null | undefined
): T {
  const base = agentId === "codex" ? (sanitizeCodexHookOutput(output) as T) : output
  const agent = agentId ? getAgent(agentId) : undefined
  return translateHookOutputToolNames(base, agent)
}

export function sanitizeHookOutputForCurrentAgent<T extends HookOutputLike>(output: T): T {
  return sanitizeHookOutputForAgent(output, detectCurrentAgentFromEnv()?.id)
}
