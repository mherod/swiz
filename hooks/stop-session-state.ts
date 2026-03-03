#!/usr/bin/env bun
// Stop hook: Warn when session ends while project is in a non-terminal state.

import { readProjectState, STATE_TRANSITIONS, TERMINAL_STATES } from "../src/settings.ts"
import { blockStop, isGitRepo, type StopHookInput } from "./hook-utils.ts"

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput
  const cwd = input.cwd
  if (!cwd) return
  if (!(await isGitRepo(cwd))) return

  const state = await readProjectState(cwd)
  if (!state) return
  if (TERMINAL_STATES.includes(state)) return

  const transitions = STATE_TRANSITIONS[state]
  const transitionHint =
    transitions.length > 0
      ? `\n\nRun "swiz state set <state>" to transition. Allowed from "${state}": ${transitions.join(", ")}.`
      : ""

  const reason =
    `Project state is "${state}" (non-terminal). ` +
    `Consider transitioning to a terminal state before stopping, ` +
    `or use "swiz state set" to update the state when your workflow changes.` +
    transitionHint

  blockStop(reason, { includeUpdateMemoryAdvice: false })
}

main()
