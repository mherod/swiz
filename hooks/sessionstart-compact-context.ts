#!/usr/bin/env bun
// SessionStart hook (compact matcher): Re-inject core conventions after context compaction.
// Also plays a TTS narration if speak is enabled.

import { dirname, join } from "node:path"
import { readSwizSettings } from "../src/settings.ts"
import { emitContext, type SessionHookInput } from "./hook-utils.ts"

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as SessionHookInput
  const matcher = input.matcher ?? input.trigger ?? ""

  // Only fire on compact/resume events, not fresh sessions
  if (matcher !== "compact" && matcher !== "resume") return

  // Speak narration if enabled (before emitting context since emitContext exits)
  const settings = await readSwizSettings()
  if (settings.speak) {
    const speakScript = join(dirname(import.meta.path), "speak.ts")
    const message = "Just a moment while I gather my thoughts"
    const proc = Bun.spawn(["bun", speakScript], {
      stdin: new Response(message).body!,
      stderr: "pipe",
    })
    await new Response(proc.stderr).text()
    await proc.exited
  }

  const ctx =
    "Post-compaction context: Use rg instead of grep. Use the Edit/StrReplace tool, never sed/awk. " +
    "Do not co-author commits or PRs. Never disable code checks or quality gates. " +
    "Run git diff after reaching success. Check task list before starting new work."

  emitContext("SessionStart", ctx)
}

main()
