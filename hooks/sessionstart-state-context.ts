#!/usr/bin/env bun
// SessionStart hook: inject current project state into session context

import { readProjectState, STATE_TRANSITIONS, TERMINAL_STATES } from "../src/settings.ts"
import { emitContext, isGitRepo, type SessionHookInput } from "./hook-utils.ts"

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as SessionHookInput
  const cwd = input.cwd
  if (!cwd) return

  if (!(await isGitRepo(cwd))) return

  const state = await readProjectState(cwd)
  if (!state) return

  const transitions = STATE_TRANSITIONS[state]
  const isTerminal = TERMINAL_STATES.includes(state)

  const parts: string[] = [`Project state: ${state}${isTerminal ? " (terminal)" : ""}.`]
  if (transitions.length > 0) {
    parts.push(`Allowed transitions: ${transitions.join(", ")}.`)
  }

  emitContext("SessionStart", parts.join(" "))
}

await main()
