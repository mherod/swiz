#!/usr/bin/env bun

// SessionStart hook: inject current project state into session context

import { readProjectState, STATE_TRANSITIONS } from "../src/settings.ts"
import { getStatePriority, getWorkflowIntent, STATE_METADATA } from "../src/state-machine.ts"
import { emitContext, isGitRepo } from "./hook-utils.ts"
import { sessionHookInputSchema } from "./schemas.ts"

async function main(): Promise<void> {
  const input = sessionHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd
  if (!cwd) return

  if (!(await isGitRepo(cwd))) return

  const state = await readProjectState(cwd)
  if (!state) return

  const metadata = STATE_METADATA[state]
  const intent = getWorkflowIntent(state)
  const priority = getStatePriority(state)
  const transitions = STATE_TRANSITIONS[state]

  const parts: string[] = [
    `Project state: ${state}${metadata.isTerminal ? " (terminal)" : ""}.`,
    `Workflow intent: ${intent} (priority: ${priority}/4).`,
  ]

  if (transitions.length > 0) {
    parts.push(`Allowed transitions: ${transitions.join(", ")}.`)
  }

  if (metadata.description) {
    parts.push(`State description: ${metadata.description}`)
  }

  emitContext("SessionStart", parts.join(" "))
}

await main()
