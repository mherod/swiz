#!/usr/bin/env bun
// Stop hook: Remind to update memory if CLAUDE.md / MEMORY.md haven't been
// touched recently. Runs with its own cooldown independent of stop-auto-continue.

import { stat } from "node:fs/promises"
import { join } from "node:path"
import { getHomeDirOrNull } from "../src/home.ts"
import { stopHookInputSchema } from "./schemas.ts"
import { blockStop, isGitRepo, skillAdvice } from "./utils/hook-utils.ts"

const MEMORY_RECENCY_WINDOW_MS = 30 * 60 * 1000

async function memoryRecentlyUpdated(cwd: string): Promise<boolean> {
  const home = getHomeDirOrNull()
  const projectKey = home
    ? (await import("../src/transcript-utils.ts")).projectKeyFromCwd(cwd)
    : null
  const candidates = [
    join(cwd, "CLAUDE.md"),
    ...(home ? [join(home, ".claude", "CLAUDE.md")] : []),
    ...(home && projectKey
      ? [join(home, ".claude", "projects", projectKey, "memory", "MEMORY.md")]
      : []),
  ]
  for (const f of candidates) {
    try {
      const s = await stat(f)
      if (Date.now() - s.mtimeMs < MEMORY_RECENCY_WINDOW_MS) return true
    } catch {}
  }
  return false
}

async function main(): Promise<void> {
  const input = stopHookInputSchema.parse(await Bun.stdin.json())
  const cwd = input.cwd ?? process.cwd()
  if (!(await isGitRepo(cwd))) return

  if (await memoryRecentlyUpdated(cwd)) return

  const reflectAdvice = skillAdvice(
    "reflect-on-session-mistakes",
    "run /reflect-on-session-mistakes to identify patterns to avoid",
    "review the session transcript for patterns to avoid"
  )

  blockStop(
    `Next step: Reflect on this session's work: ${reflectAdvice}\n\n` +
      "review the session transcript for patterns to avoid, " +
      "then update MEMORY.md with any confirmed directives from this session."
  )
}

if (import.meta.main) void main()
