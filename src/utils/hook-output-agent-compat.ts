import { detectCurrentAgentFromEnv } from "../agent-paths.ts"

type HookOutputLike = Record<string, any>

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sanitizeCodexPreToolUseAllow(output: HookOutputLike): HookOutputLike {
  const cloned = structuredClone(output) as HookOutputLike

  delete cloned.suppressOutput

  const hookSpecificOutput = cloned.hookSpecificOutput
  if (!isPlainObject(hookSpecificOutput)) return cloned

  if (hookSpecificOutput.permissionDecision === "allow") {
    const reason =
      typeof hookSpecificOutput.permissionDecisionReason === "string" &&
      hookSpecificOutput.permissionDecisionReason.trim()
        ? hookSpecificOutput.permissionDecisionReason
        : undefined

    delete hookSpecificOutput.permissionDecision
    delete hookSpecificOutput.permissionDecisionReason

    if (
      reason &&
      (typeof hookSpecificOutput.additionalContext !== "string" ||
        hookSpecificOutput.additionalContext.trim().length === 0)
    ) {
      hookSpecificOutput.additionalContext = reason
    }
  }

  if (Object.keys(hookSpecificOutput).length === 0) {
    delete cloned.hookSpecificOutput
  }

  return cloned
}

export function sanitizeHookOutputForCurrentAgent<T extends HookOutputLike>(output: T): T {
  if (detectCurrentAgentFromEnv()?.id !== "codex") return output
  return sanitizeCodexPreToolUseAllow(output) as T
}
