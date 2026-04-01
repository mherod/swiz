#!/usr/bin/env bun

// SessionStart hook: inject current project state into session context

import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { buildContextHookOutput, isGitRepo } from "../src/utils/hook-utils.ts"
import { sessionStartHookInputSchema } from "./schemas.ts"
import { readSessionStartStateInfo } from "./sessionstart-state-utils.ts"

export async function evaluateSessionstartStateContext(input: unknown): Promise<SwizHookOutput> {
  const hookInput = sessionStartHookInputSchema.parse(input)
  const cwd = hookInput.cwd
  if (!cwd) return {}

  if (!(await isGitRepo(cwd))) return {}

  const stateInfo = await readSessionStartStateInfo(cwd)
  if (!stateInfo) return {}

  const parts: string[] = [
    `Project state: ${stateInfo.state}.`,
    `Workflow intent: ${stateInfo.intent} (priority: ${stateInfo.priority}/4).`,
  ]

  if (stateInfo.transitions.length > 0) {
    parts.push(`Allowed transitions: ${stateInfo.transitions.join(", ")}.`)
  }

  if (stateInfo.description) {
    parts.push(`State description: ${stateInfo.description}`)
  }

  return buildContextHookOutput("SessionStart", parts.join(" "))
}

const sessionstartStateContext: SwizHook<Record<string, any>> = {
  name: "sessionstart-state-context",
  event: "sessionStart",
  matcher: "startup",
  timeout: 5,
  run(input) {
    return evaluateSessionstartStateContext(input)
  },
}

export default sessionstartStateContext

if (import.meta.main) {
  await runSwizHookAsMain(sessionstartStateContext)
}
