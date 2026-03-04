#!/usr/bin/env bun
// PreCompact hook: Speak a narration before context compaction begins.

import { readSwizSettings } from "../src/settings.ts"
import { spawnSpeak } from "./hook-utils.ts"

async function main(): Promise<void> {
  // Consume stdin (required by hook protocol)
  await Bun.stdin.json().catch(() => null)

  const settings = await readSwizSettings()
  if (!settings.speak) return

  await spawnSpeak("Just a moment while I gather my thoughts", settings)
}

main()
