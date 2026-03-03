#!/usr/bin/env bun
// PreCompact hook: Speak a narration before context compaction begins.

import { dirname, join } from "node:path"
import { readSwizSettings } from "../src/settings.ts"

async function main(): Promise<void> {
  // Consume stdin (required by hook protocol)
  await Bun.stdin.json().catch(() => null)

  const settings = await readSwizSettings()
  if (!settings.speak) return

  const speakScript = join(dirname(import.meta.path), "speak.ts")
  const message = "Just a moment while I gather my thoughts"
  const speakArgs = ["bun", speakScript]
  if (settings.narratorVoice) speakArgs.push("--voice", settings.narratorVoice)
  if (settings.narratorSpeed > 0) speakArgs.push("--speed", String(settings.narratorSpeed))
  const proc = Bun.spawn(speakArgs, {
    stdin: new Response(message).body!,
    stderr: "pipe",
  })
  await new Response(proc.stderr).text()
  await proc.exited
}

main()
