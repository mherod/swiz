#!/usr/bin/env bun

// Stop hook: Warn when session ends while project is in a non-terminal state.

import { readProjectState, writeProjectState } from "../src/settings.ts"
import { STATE_METADATA } from "../src/state-machine.ts"
import { isGitRepo } from "./hook-utils.ts"
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

  // Auto-transition non-terminal states to paused on session stop
  await writeProjectState(cwd, "paused")
}

main()
