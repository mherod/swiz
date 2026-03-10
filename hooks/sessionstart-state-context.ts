#!/usr/bin/env bun

// SessionStart hook: inject current project state into session context

import { emitContext, isGitRepo } from "./hook-utils.ts"
import { sessionHookInputSchema } from "./schemas.ts"
import { readSessionStartStateInfo } from "./sessionstart-state-utils.ts"

async function main(): Promise<void> {
  const input = sessionHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd
  if (!cwd) return

  if (!(await isGitRepo(cwd))) return

  const stateInfo = await readSessionStartStateInfo(cwd)
  if (!stateInfo) return

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

  emitContext("SessionStart", parts.join(" "))
}

if (import.meta.main) await main()
