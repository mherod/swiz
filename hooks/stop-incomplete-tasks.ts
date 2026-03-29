#!/usr/bin/env bun
// Block stop when incomplete tasks remain in the current session.
// Runs before the completion auditor so incomplete tasks are caught early.

import { getHomeDirOrNull } from "../src/home.ts"
import { checkIncompleteTasks } from "../src/utils/stop-incomplete-tasks-core.ts"
import { stopHookInputSchema } from "./schemas.ts"

async function main(): Promise<void> {
  const raw = (await Bun.stdin.json()) as Record<string, unknown>
  const input = stopHookInputSchema.parse(raw)
  const sessionId = input.session_id ?? ""
  const home = getHomeDirOrNull()
  if (!home) return

  const result = await checkIncompleteTasks(sessionId, home)
  if (result) {
    console.log(JSON.stringify(result))
    process.exit(0)
  }
}

if (import.meta.main) {
  void main()
}
