#!/usr/bin/env bun

// Stop hook: Warn when session ends while project is in a non-terminal state.

import { readProjectState, STATE_TRANSITIONS } from "../src/settings.ts"
import { STATE_METADATA } from "../src/state-machine.ts"
import { blockStop, isGitRepo } from "./hook-utils.ts"
import { stopHookInputSchema } from "./schemas.ts"

async function main(): Promise<void> {
  const input = stopHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd
  if (!cwd) return
  if (!(await isGitRepo(cwd))) return

  const state = await readProjectState(cwd)
  if (!state) return

  const metadata = STATE_METADATA[state]
  if (metadata.isTerminal) return

  const transitions = STATE_TRANSITIONS[state]
  const transitionHint =
    transitions.length > 0
      ? `\n\nRun "swiz state set <state>" to transition. Allowed from "${state}": ${transitions.join(", ")}.`
      : ""

  const reason =
    `Project state is "${state}" (${metadata.intent}, non-terminal).\n\n` +
    `${metadata.description}\n\n` +
    `Consider transitioning to a terminal state before stopping, ` +
    `or use "swiz state set" to update the state when your workflow changes.` +
    transitionHint

  blockStop(reason, { includeUpdateMemoryAdvice: false })
}

main()
